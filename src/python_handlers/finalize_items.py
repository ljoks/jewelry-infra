import json
import os
import time
import requests
import boto3
from logger import create_logger, Logger

s3 = boto3.client('s3')
dynamo = boto3.resource('dynamodb')
secrets_client = boto3.client("secretsmanager")

BUCKET_NAME = os.environ.get('BUCKET_NAME', '')
ITEMS_TABLE_NAME = os.environ.get('ITEMS_TABLE', '')
IMAGES_TABLE_NAME = os.environ.get('IMAGES_TABLE', '')
COUNTER_TABLE_NAME = os.environ.get('COUNTER_TABLE', '')

_cached_api_key = None # Global cache for the API key
_handler_logger: Logger = None  # Module-level logger reference

items_table = dynamo.Table(ITEMS_TABLE_NAME)
images_table = dynamo.Table(IMAGES_TABLE_NAME)
counter_table = dynamo.Table(COUNTER_TABLE_NAME)

def generate_item_id() -> str:
    """
    Generate a sequential ID for an item using a global atomic counter
    """
    global _handler_logger
    try:
        # Update the counter atomically and get the new value
        response = counter_table.update_item(
            Key={
                'counter_name': 'GLOBAL',
                'counter_type': 'ITEM'
            },
            UpdateExpression='ADD #count :inc',
            ExpressionAttributeNames={
                '#count': 'count'
            },
            ExpressionAttributeValues={
                ':inc': 1
            },
            ReturnValues='UPDATED_NEW'
        )
        
        # Get the new count and return it as a string
        new_id = str(response['Attributes']['count'])
        if _handler_logger:
            _handler_logger.debug("Generated sequential ID", {"item_id": new_id})
        return new_id
    except Exception as e:
        if _handler_logger:
            _handler_logger.error("Error generating sequential ID", e)
        raise

def lambda_handler(event, context):
    """
    POST /finalizeItems

    Expects JSON body like:
    {
      "auction_id": "auctionABC",
      "created_by": "user123",  // ID of the user creating these items
      "metadata": {             // Optional metadata that applies to ALL items
        "collection": "summer2024",
        "source": "estate_sale"
      },
      "groups": [
        {
          "item_index": 0,
          "images": [
            { "index": 0, "imageKey": "uploads/item1_top.jpg" },
            { "index": 3, "imageKey": "uploads/item1_side.jpg" }
          ]
        },
        ...
      ]
    }

    Steps:
      1) Generate item description using OpenAI
      2) Create the new item record in the ItemsTable (DynamoDB)
      3) Create image records in the ImagesTable
    """
    global _handler_logger
    _handler_logger = create_logger(event, context)
    _handler_logger.log_request(event)

    try:
        if event["requestContext"]["http"]["method"] != "POST":
            _handler_logger.warn("Method not allowed", {"method": event["requestContext"]["http"]["method"]})
            return build_response(405, {"error": "Method not allowed."})

        body = json.loads(event.get("body", "{}"))
        auction_id = body.get("auction_id")
        created_by = body.get("created_by")  # Get the user ID who is creating the items
        metadata = body.get("metadata", {})  # Get metadata that applies to all items
        groups = body.get("groups", [])

        _handler_logger.info("Finalize items request", {
            "auction_id": auction_id,
            "created_by": created_by,
            "group_count": len(groups)
        })

        if not groups:
            _handler_logger.warn("No groups provided")
            return build_response(400, {"error": "groups[] is required."})
            
        if not created_by:
            _handler_logger.warn("created_by not provided")
            return build_response(400, {"error": "created_by is required."})

        created_items = []

        # Process each group => one item
        for group in groups:
            item_index = group.get("item_index", -1)
            images = group.get("images", [])

            _handler_logger.info("Processing group", {"item_index": item_index, "image_count": len(images)})

            # Sort images by index to preserve the original order
            images.sort(key=lambda x: x.get("index", float('inf')))

            item_id = generate_item_id()
            now_ts = int(time.time())

            # Get the image keys
            image_keys = [img_info.get("imageKey") for img_info in images if img_info.get("imageKey")]

            # Generate all item details in a single API call
            _handler_logger.info("Generating item details via OpenAI", {"item_id": item_id, "image_count": len(image_keys)})
            item_details = generate_item_details(image_keys, metadata)

            # Merge discovered metadata with existing metadata
            if item_details.get("discovered_metadata"):
                metadata.update(item_details["discovered_metadata"])

            # Insert the final item in DynamoDB
            item_data = {
                "item_id": item_id,
                "item_index": item_index,
                "metadata": metadata,
                "images": image_keys,
                "title": item_details["title"],
                "description": item_details["description"],
                "value_estimate": item_details["value_estimate"],
                "created_at": now_ts,
                "updated_at": now_ts,
                "created_by": created_by
            }
            
            # Only include auction_id if it was provided and not empty/None
            if auction_id and auction_id.strip():
                item_data["auction_id"] = auction_id

            items_table.put_item(Item=item_data)
            _handler_logger.info("Item created in DynamoDB", {"item_id": item_id, "title": item_details.get("title")})

            # Insert images in the ImagesTable
            for key in image_keys:
                image_id = generate_image_id()
                image_data = {
                    "image_id": image_id,
                    "item_id": item_id,
                    "s3_key_original": key,
                    "created_at": now_ts
                }
                
                # Only include auction_id if it was provided and not empty/None
                if auction_id and auction_id.strip():
                    image_data["auction_id"] = auction_id
                    
                images_table.put_item(Item=image_data)

            _handler_logger.info("Images created for item", {"item_id": item_id, "image_count": len(image_keys)})
            created_items.append(item_data)

        _handler_logger.info("All items finalized successfully", {"item_count": len(created_items)})
        return build_response(201, {"message": "Items finalized", "items": created_items})

    except Exception as e:
        _handler_logger.error("Error finalizing items", e, {"auction_id": auction_id if 'auction_id' in dir() else None})
        return build_response(500, {"error": "Internal server error", "detail": str(e)})

def generate_item_details(image_keys, metadata) -> dict:
    """
    Generate title, description, and value estimate for an item in a single API call.
    Uses OpenAI's API to analyze the images and create all necessary details.
    """
    global _handler_logger
    
    openai_api_key = get_api_key()
    if not openai_api_key:
        if _handler_logger:
            _handler_logger.warn("OpenAI API key not available")
        return {
            "title": "Untitled Item",
            "description": "No description (missing OpenAI key)",
            "value_estimate": {"min_value": 0, "max_value": 0, "currency": "USD"},
            "discovered_metadata": {}
        }

    # Construct image URLs from S3 keys
    image_urls = [
        {"type": "image_url", "image_url": {"url": f"https://{BUCKET_NAME}.s3.amazonaws.com/{k}"}}
        for k in image_keys
    ]

    # Construct prompt text that asks for all components
    prompt_text = """You are an expert jewelry appraiser and marketer. Based on these images, provide the following details in JSON format:

1. A concise title (maximum 60 characters) highlighting key features
2. A marketing-friendly description of the piece in plaintext
3. A value estimate considering materials, craftsmanship, condition, design complexity, and market trends
4. Discovered metadata including:
   - Weight in grams if a scale is visible in any image
   - Any markings or stamps visible on the jewelry (e.g. 14K, 925, maker's marks)

Respond in this exact JSON format:
{
    "title": "<concise title>",
    "description": "<marketing description>",
    "value_estimate": {
        "min_value": <number>,
        "max_value": <number>,
        "currency": "USD"
    },
    "discovered_metadata": {
        "weight_grams": <number or null if not visible>,
        "markings": ["<marking1>", "<marking2>", ...] or [] if none visible
    }
}"""

    # Append metadata if available
    if metadata:
        prompt_text += f"\n\nExisting Metadata:\n{metadata}"

    # Create the messages payload
    messages = [
        {
            "role": "user",
            "content": [{"type": "text", "text": prompt_text}] + image_urls,
        }
    ]

    # Construct the request payload
    payload = {
        "model": "gpt-4o-mini",
        "messages": messages,
        "max_tokens": 1000
    }

    headers = {
        "Authorization": f"Bearer {openai_api_key}",
        "Content-Type": "application/json"
    }

    try:
        resp = requests.post("https://api.openai.com/v1/chat/completions", json=payload, headers=headers)
        if resp.status_code != 200:
            if _handler_logger:
                _handler_logger.error("OpenAI API error", None, {"status": resp.status_code, "response": resp.text[:500]})
            return {
                "title": "Untitled Item",
                "description": "Failed to generate description (OpenAI error).",
                "value_estimate": {"min_value": 0, "max_value": 0, "currency": "USD"},
                "discovered_metadata": {}
            }
        
        if _handler_logger:
            _handler_logger.debug("OpenAI API response received")
        
        data = resp.json()
        if not data.get("choices") or not data["choices"]:
            if _handler_logger:
                _handler_logger.error("OpenAI returned no choices", None, {"data": str(data)[:500]})
            return {
                "title": "Untitled Item",
                "description": "Failed to generate description (no response).",
                "value_estimate": {"min_value": 0, "max_value": 0, "currency": "USD"},
                "discovered_metadata": {}
            }

        content = data["choices"][0]["message"]["content"]
        if not content:
            if _handler_logger:
                _handler_logger.error("OpenAI returned empty content")
            return {
                "title": "Untitled Item",
                "description": "Failed to generate description (empty response).",
                "value_estimate": {"min_value": 0, "max_value": 0, "currency": "USD"},
                "discovered_metadata": {}
            }

        # Clean the content by removing markdown code blocks if present
        content = content.strip()
        if content.startswith('```json'):
            content = content[7:]  # Remove ```json
        if content.endswith('```'):
            content = content[:-3]  # Remove ```
        content = content.strip()

        try:
            result = json.loads(content)
        except json.JSONDecodeError as e:
            if _handler_logger:
                _handler_logger.error("Failed to parse OpenAI JSON response", e, {"content": content[:500]})
            return {
                "title": "Untitled Item",
                "description": "Failed to generate description (invalid response format).",
                "value_estimate": {"min_value": 0, "max_value": 0, "currency": "USD"},
                "discovered_metadata": {}
            }
        
        # Validate required fields
        if not all(key in result for key in ["title", "description", "value_estimate", "discovered_metadata"]):
            if _handler_logger:
                _handler_logger.error("OpenAI response missing required fields", None, {"keys": list(result.keys())})
            return {
                "title": "Untitled Item",
                "description": "Failed to generate description (incomplete response).",
                "value_estimate": {"min_value": 0, "max_value": 0, "currency": "USD"},
                "discovered_metadata": {}
            }
        
        # Add disclaimer to description
        DISCLAIMER_PHRASE = (
            "All photos represent the lot condition and may contain unseen imperfections in addition to "
            "the information provided. All items are described to the best of our abilities. Please "
            "communicate all questions and concerns prior to bidding. Please read our terms and "
            "conditions for more details. Good luck bidding."
        )
        result["description"] = f"{result['description']}\n\n{DISCLAIMER_PHRASE}"
        
        if _handler_logger:
            _handler_logger.info("Item details generated successfully", {
                "title": result.get("title"),
                "value_estimate": result.get("value_estimate")
            })
        
        return result
    except requests.exceptions.RequestException as e:
        if _handler_logger:
            _handler_logger.error("OpenAI request failed (network error)", e)
        return {
            "title": "Untitled Item",
            "description": "Failed to generate description (network error).",
            "value_estimate": {"min_value": 0, "max_value": 0, "currency": "USD"},
            "discovered_metadata": {}
        }
    except Exception as e:
        if _handler_logger:
            _handler_logger.error("OpenAI request failed (exception)", e)
        return {
            "title": "Untitled Item",
            "description": "Failed to generate description due to exception.",
            "value_estimate": {"min_value": 0, "max_value": 0, "currency": "USD"},
            "discovered_metadata": {}
        }

def build_response(status_code: int, body):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body)
    }

def generate_image_id() -> str:
    return f"img_{int(time.time())}"

def get_api_key():
    global _cached_api_key, _handler_logger
    if _cached_api_key:
        if _handler_logger:
            _handler_logger.debug("Using cached OpenAI API key")
        return _cached_api_key

    secret_arn = os.getenv('OPENAI_SECRET_ARN')
    if not secret_arn:
        if _handler_logger:
            _handler_logger.error("OPENAI_SECRET_ARN environment variable is not set")
        raise ValueError("OPENAI_SECRET_ARN environment variable is not set")

    if _handler_logger:
        _handler_logger.info("Fetching API key from Secrets Manager")

    client = boto3.client('secretsmanager', region_name=os.getenv('AWS_REGION', 'us-east-1'))

    try:
        response = client.get_secret_value(SecretId=secret_arn)
        secret_string = response.get('SecretString')

        if secret_string:
            secret_dict = json.loads(secret_string)
            _cached_api_key = secret_dict.get('api_key')

            if not _cached_api_key:
                if _handler_logger:
                    _handler_logger.error("api_key not found in secret")
                raise ValueError("api_key not found in secret")

            if _handler_logger:
                _handler_logger.info("OpenAI API key retrieved and cached")
            return _cached_api_key
    except Exception as e:
        if _handler_logger:
            _handler_logger.error("Error fetching secret from Secrets Manager", e)
        raise
