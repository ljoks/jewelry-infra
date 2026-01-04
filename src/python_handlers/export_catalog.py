import json
import os
import boto3
import csv
from io import StringIO
from logger import create_logger

# Initialize AWS clients
dynamo = boto3.resource('dynamodb')
s3 = boto3.client('s3')

# Get environment variables
ITEMS_TABLE_NAME = os.environ.get('ITEMS_TABLE', '')
IMAGES_TABLE_NAME = os.environ.get('IMAGES_TABLE', '')
BUCKET_NAME = os.environ.get('BUCKET_NAME', '')

items_table = dynamo.Table(ITEMS_TABLE_NAME)
images_table = dynamo.Table(IMAGES_TABLE_NAME)

# LiveAuctioneers required columns
LIVE_AUCTIONEERS_COLUMNS = [
    'LotNum',
    'Title',
    'Description',
    'LowEst',
    'HighEst',
    'StartPrice',
    'Condition'
] + [f'ImageFile.{i}' for i in range(1, 21)]  # Support up to 20 images per item

def lambda_handler(event, context):
    """
    POST /export/catalog
    
    Exports auction items to a CSV format for various platforms.
    Currently supports LiveAuctioneers format.
    
    Expected JSON body:
    {
        "auction_id": "auction123",
        "platform": "liveauctioneers"
    }
    """
    log = create_logger(event, context)
    log.log_request(event)
    
    try:
        if event["requestContext"]["http"]["method"] != "POST":
            log.warn("Method not allowed", {"method": event["requestContext"]["http"]["method"]})
            return build_response(405, {"error": "Method not allowed"})
            
        body = json.loads(event.get("body", "{}"))
        auction_id = body.get("auction_id")
        platform = body.get("platform", "").lower()
        
        log.info("Export catalog request", {"auction_id": auction_id, "platform": platform})
        
        if not auction_id:
            log.warn("Missing auction_id in request")
            return build_response(400, {"error": "auction_id is required"})
            
        if platform not in ["liveauctioneers"]:
            log.warn("Unsupported platform", {"platform": platform})
            return build_response(400, {"error": "Unsupported platform. Currently only 'liveauctioneers' is supported."})
            
        # Query items for this auction
        log.info("Querying items for auction", {"auction_id": auction_id})
        items_result = items_table.query(
            IndexName="auctionIdIndex",
            KeyConditionExpression="auction_id = :auctionId",
            ExpressionAttributeValues={":auctionId": auction_id}
        )
        
        items = items_result.get('Items', [])
        log.info("Items retrieved", {"auction_id": auction_id, "item_count": len(items)})
        
        if not items:
            log.warn("No items found for auction", {"auction_id": auction_id})
            return build_response(404, {"error": f"No items found for auction {auction_id}"})
            
        # Generate CSV based on platform
        log.info("Generating CSV for platform", {"platform": platform, "item_count": len(items)})
        if platform == "liveauctioneers":
            csv_content = generate_live_auctioneers_csv(items)
            
        # Upload CSV to S3
        csv_key = f"exports/{auction_id}/{platform}_catalog.csv"
        log.info("Uploading CSV to S3", {"bucket": BUCKET_NAME, "key": csv_key})
        s3.put_object(
            Bucket=BUCKET_NAME,
            Key=csv_key,
            Body=csv_content,
            ContentType='text/csv'
        )
        
        # Generate a presigned URL for downloading the CSV
        presigned_url = s3.generate_presigned_url(
            'get_object',
            Params={'Bucket': BUCKET_NAME, 'Key': csv_key},
            ExpiresIn=3600  # URL valid for 1 hour
        )
        
        log.info("Catalog exported successfully", {"auction_id": auction_id, "platform": platform, "s3_key": csv_key})
        
        return build_response(200, {
            "message": "Catalog exported successfully",
            "download_url": presigned_url
        })
            
    except Exception as e:
        log.error("Error exporting catalog", e, {"auction_id": body.get("auction_id") if 'body' in dir() else None})
        return build_response(500, {"error": "Internal server error", "detail": str(e)})

def generate_live_auctioneers_csv(items):
    """
    Generates a CSV file in LiveAuctioneers format with the required fields:
    - LotNum: Increasing number starting from 1
    - Title: Item title
    - Description: Item description
    - LowEst: Low estimate value
    - HighEst: High estimate value
    - StartPrice: 20% of the low estimate
    - Condition: 'Good' by default
    - ImageFile.1 through ImageFile.N: Image URLs
    """
    output = StringIO()
    writer = csv.DictWriter(output, fieldnames=LIVE_AUCTIONEERS_COLUMNS)
    writer.writeheader()
    
    for lot_num, item in enumerate(items, start=1):
        # Get image URLs directly from the item's images field
        image_urls = []
        for image_key in item.get('images', []):
            image_url = f"https://{BUCKET_NAME}.s3.amazonaws.com/{image_key}"
            image_urls.append(image_url)
            
        # Extract value estimate
        value_estimate = item.get('value_estimate', {})
        min_value = value_estimate.get('min_value')
        max_value = value_estimate.get('max_value')
        
        # Handle cases where values might be None or missing
        try:
            low_est = float(min_value) if min_value is not None else 0.0
            high_est = float(max_value) if max_value is not None else 0.0
        except (ValueError, TypeError):
            low_est = 0.0
            high_est = 0.0
        
        # Calculate start price as 20% of low estimate
        start_price = round(low_est * 0.2, 2)
        
        # Create base row with required fields
        row = {
            'LotNum': lot_num,
            'Title': item.get('title', ''),
            'Description': item.get('description', ''),
            'LowEst': low_est,
            'HighEst': high_est,
            'StartPrice': start_price,
            'Condition': 'Good'
        }
        
        # Add image URLs to their respective columns
        for i, url in enumerate(image_urls, start=1):
            if i <= 20:  # Only include up to 20 images
                row[f'ImageFile.{i}'] = url
        
        # Fill remaining image columns with empty strings
        for i in range(len(image_urls) + 1, 21):
            row[f'ImageFile.{i}'] = ''
        
        writer.writerow(row)
    
    return output.getvalue()

def build_response(status_code, body):
    """Helper function to build API response"""
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
        },
        "body": json.dumps(body)
    } 