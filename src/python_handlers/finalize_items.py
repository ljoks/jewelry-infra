import json
import os
import time
import requests
import boto3
import cv2 as cv
import numpy as np

s3 = boto3.client('s3')
dynamo = boto3.resource('dynamodb')
secrets_client = boto3.client("secretsmanager")

BUCKET_NAME = os.environ.get('BUCKET_NAME', '')
ITEMS_TABLE_NAME = os.environ.get('ITEMS_TABLE', '')
IMAGES_TABLE_NAME = os.environ.get('IMAGES_TABLE', '')

_cached_api_key = None # Global cache for the API key

items_table = dynamo.Table(ITEMS_TABLE_NAME)
images_table = dynamo.Table(IMAGES_TABLE_NAME)

def lambda_handler(event, context):
    """
    POST /finalizeItems

    Expects JSON body like:
    {
      "auction_id": "auctionABC",
      "groups": [
        {
          "marker_id": "marker_42",
          "images": [
            { "index": 0, "imageKey": "uploads/tmp123.jpg" },
            { "index": 1, "imageKey": "uploads/tmp124.jpg" }
          ]
        },
        ...
      ]
    }

    Steps:
      1) Parse additional markers (metadata) from images (parse_additional_markers).
      2) Remove the main item marker from each image (remove_item_marker).
      3) Upload the cropped image to S3.
      4) Delete the original image from S3.
      5) Generate an item description (generate_description).
      6) Create the new item record in the ItemsTable (DynamoDB).
      7) Create image records in the ImagesTable if desired.
    """

    try:
        print(event)

        if event["requestContext"]["http"]["method"] != "POST":
            return build_response(405, {"error": "Method not allowed."})

        body = json.loads(event.get("body", "{}"))
        auction_id = body.get("auction_id")
        groups = body.get("groups", [])

        if not auction_id or not groups:
            return build_response(400, {"error": "auction_id and groups[] are required."})

        created_items = []

        # Process each group => one item
        for group in groups:
            marker_id = group.get("marker_id", "unknown")
            images = group.get("images", [])

            item_id = generate_item_id(marker_id)
            now_ts = int(time.time())
            metadata = {}

            # We'll store final cropped S3 paths here
            cropped_image_keys = []

            for img_info in images:
                original_key = img_info.get("imageKey")
                if not original_key:
                    continue

                # 1) Download from S3
                original_img = download_s3_image(BUCKET_NAME, original_key)
                if original_img is None:
                    continue

                # 2) Parse additional markers => gather metadata
                #    (e.g., ring size, metal type, etc.)
                more_data = parse_additional_markers(original_img)
                # Merge into our item-level metadata
                # If there's a conflict, last image's marker wins or merges
                metadata.update(more_data)

                # 3) Remove main item marker
                cropped_img = remove_item_marker(original_img)

                # 4) Upload the cropped image
                cropped_key = f"cropped/{auction_id}/{item_id}-{now_ts}-{time.time_ns()}.jpg"
                upload_cropped_image(cropped_img, BUCKET_NAME, cropped_key)

                # 5) Delete original
                try:
                    s3.delete_object(Bucket=BUCKET_NAME, Key=original_key)
                    print('original image deleted')
                except Exception as e:
                    print(f"Error deleting {original_key}: {e}")

                cropped_image_keys.append(cropped_key)

            # 6) Generate item description
            description = generate_description(cropped_image_keys, metadata)

            # 7) Insert the final item in DynamoDB
            item_data = {
                "item_id": item_id,
                "auction_id": auction_id,
                "marker_id": marker_id,
                "metadata": metadata,
                "images": cropped_image_keys,
                "description": description,
                "created_at": now_ts,
                "updated_at": now_ts
            }
            items_table.put_item(Item=item_data)

            # 8) Insert images in the ImagesTable (optional)
            for ckey in cropped_image_keys:
                image_id = generate_image_id()
                images_table.put_item(Item={
                    "image_id": image_id,
                    "item_id": item_id,
                    "auction_id": auction_id,
                    "s3_key_original": ckey,
                    "created_at": now_ts
                })

            created_items.append(item_data)

        return build_response(201, {"message": "Items finalized", "items": created_items})

    except Exception as e:
        print(e)
        return build_response(500, {"error": "Internal server error", "detail": str(e)})


# -----------------------------------------------------------------------
# MARKER & METADATA FUNCTIONS
# -----------------------------------------------------------------------

def parse_additional_markers(image: np.ndarray) -> dict:
    """
    Detect other (non-item) markers that might specify metadata, e.g. metal type, ring size, etc.
    For now, we just do a dummy detection. In production, you'd do a separate ArUco pass
    or custom logic to extract embedded info.

    Returns a dict of metadata fields, e.g. {"metal": "gold", "size": "7"}
    """
    # Dummy approach:
    dictionary = cv.aruco.getPredefinedDictionary(cv.aruco.DICT_4X4_250)
    parameters = cv.aruco.DetectorParameters()
    detector = cv.aruco.ArucoDetector(dictionary, parameters)

    gray = cv.cvtColor(image, cv.COLOR_BGR2GRAY)
    markerCorners, markerIds, _ = detector.detectMarkers(gray)

    metadata_found = {}
    if markerIds is not None and len(markerIds) > 0:
        # Suppose marker ID 99 => "metal": "silver"
        for mid in markerIds:
            if mid[0] == 99:
                metadata_found["metal"] = "silver"
            elif mid[0] == 101:
                metadata_found["size"] = "7"

    # Return the merged metadata from any markers found
    return metadata_found


def remove_item_marker(image: np.ndarray) -> np.ndarray:
    """
    Similar logic to the original Flask code's process_image_marker, but now we do
    the cropping inside a dedicated function. If we detect an item marker in the
    bottom-right quadrant, we crop it out of the image.
    """
    dictionary = cv.aruco.getPredefinedDictionary(cv.aruco.DICT_4X4_250)
    parameters = cv.aruco.DetectorParameters()
    detector = cv.aruco.ArucoDetector(dictionary, parameters)

    gray = cv.cvtColor(image, cv.COLOR_BGR2GRAY)
    markerCorners, markerIds, _ = detector.detectMarkers(gray)

    cropped_image = image
    if markerIds is not None and len(markerIds) > 0:
        # We'll remove the first detected item marker
        corners = markerCorners[0]
        pts = corners.reshape((4, 2)).astype(int)

        x, y, w, h = cv.boundingRect(pts)
        img_height, img_width = image.shape[:2]

        # If it's in bottom-right quadrant, crop it out
        if x > img_width * 0.5 and y > img_height * 0.5:
            cropped_image = image[0:y, 0:x]

    return cropped_image


# -----------------------------------------------------------------------
# IMAGE UPLOAD / DESCRIPTION GENERATION
# -----------------------------------------------------------------------

def upload_cropped_image(cropped_image: np.ndarray, bucket: str, key: str):
    """Encodes the cropped image as JPG and uploads to S3."""
    success, buffer = cv.imencode('.jpg', cropped_image)
    if not success:
        raise RuntimeError("Failed to encode cropped image as JPG")

    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=buffer.tobytes(),
        ContentType='image/jpeg'
    )


import requests

import requests

def generate_description(cropped_image_keys, metadata) -> str:
    """
    Adapts the /api/generateDescriptions logic from the original Flask code:
    - Build a prompt referencing the images
    - Call the OpenAI Chat Completions endpoint
    - Return the model's response
    """
    openai_api_key = get_api_key()
    if not openai_api_key:
        return "No description (missing OpenAI key)"

    # Construct image URLs from S3 keys
    image_urls = [
        {"type": "image_url", "image_url": {"url": f"https://{BUCKET_NAME}.s3.amazonaws.com/{k}"}}
        for k in cropped_image_keys
    ]

    # Construct prompt text
    prompt_text = "You are an expert jewelry marketer. Based on these images, generate a marketing-friendly description. Please use plain text."
    
    # Append metadata if available
    if metadata:
        prompt_text += f"\nMetadata:\n{metadata}"

    # Create the messages payload
    messages = [
        {
            "role": "user",
            "content": [{"type": "text", "text": prompt_text}] + image_urls,
        }
    ]

    # Construct the request payload
    payload = {
        "model": "gpt-4o-mini",  # or your chosen model
        "messages": messages,
        "max_tokens": 300
    }

    headers = {
        "Authorization": f"Bearer {openai_api_key}",
        "Content-Type": "application/json"
    }

    try:
        resp = requests.post("https://api.openai.com/v1/chat/completions", json=payload, headers=headers)
        if resp.status_code != 200:
            print("OpenAI Error:", resp.text)
            return "Failed to generate description (OpenAI error)."
        data = resp.json()
        model_output = data["choices"][0]["message"]["content"]

        # Fixed disclaimer to be appended
        DISCLAIMER_PHRASE = (
            "All photos represent the lot condition and may contain unseen imperfections in addition to "
            "the information provided. All items are described to the best of our abilities. Please "
            "communicate all questions and concerns prior to bidding. Please read our terms and "
            "conditions for more details. Good luck bidding."
        )

        # Append disclaimer
        final_description = f"{model_output}\n\n{DISCLAIMER_PHRASE}"
        return final_description
    except Exception as e:
        print("OpenAI request failed:", e)
        return "Failed to generate description due to exception."




# -----------------------------------------------------------------------
# UTILS
# -----------------------------------------------------------------------

def download_s3_image(bucket: str, key: str) -> np.ndarray:
    """
    Download an S3 object and decode it into an OpenCV image array.
    """
    try:
        resp = s3.get_object(Bucket=bucket, Key=key)
        data = resp['Body'].read()
        np_arr = np.frombuffer(data, np.uint8)
        image = cv.imdecode(np_arr, cv.IMREAD_COLOR)
        return image
    except Exception as e:
        print(f"Error downloading {key} from S3: {e}")
        return None

def build_response(status_code: int, body):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body)
    }

def generate_item_id(marker_id: str) -> str:
    return f"item_{marker_id}_{int(time.time())}"

def generate_image_id() -> str:
    return f"img_{int(time.time())}"

def get_api_key():
    global _cached_api_key
    if _cached_api_key:
        print("Using cached API key")
        return _cached_api_key

    secret_arn = os.getenv('OPENAI_SECRET_ARN')
    if not secret_arn:
        raise ValueError("OPENAI_SECRET_ARN environment variable is not set")

    print(f"Fetching API key from Secrets Manager: {secret_arn}")

    client = boto3.client('secretsmanager', region_name=os.getenv('AWS_REGION', 'us-east-1'))

    try:
        response = client.get_secret_value(SecretId=secret_arn)
        secret_string = response.get('SecretString')

        if secret_string:
            secret_dict = json.loads(secret_string)
            _cached_api_key = secret_dict.get('api_key')

            if not _cached_api_key:
                raise ValueError("api_key not found in secret")

            return _cached_api_key
    except Exception as e:
        print(f"Error fetching secret: {e}")
        raise
