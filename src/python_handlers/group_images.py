import json
import os
import boto3
from typing import Dict, Any, List

s3 = boto3.client('s3')
BUCKET_NAME = os.environ.get('BUCKET_NAME')

def lambda_handler(event, context):
    """
    POST /groupImages
    Expects a JSON body like:
    {
        "num_items": 3,           # Number of items being photographed
        "views_per_item": 2,      # Number of views per item (e.g. top view, side view)
        "images": [               # Images in sequence order
          { "s3Key": "uploads/item1_top.jpg" },    # First item, top view
          { "s3Key": "uploads/item2_top.jpg" },    # Second item, top view
          { "s3Key": "uploads/item3_top.jpg" },    # Third item, top view
          { "s3Key": "uploads/item1_side.jpg" },   # First item, side view
          { "s3Key": "uploads/item2_side.jpg" },   # Second item, side view
          { "s3Key": "uploads/item3_side.jpg" }    # Third item, side view
        ]
    }
    Returns something like:
    [
      {
        "item_index": 0,
        "images": [
          { "index": 0, "imageKey": "uploads/item1_top.jpg" },
          { "index": 3, "imageKey": "uploads/item1_side.jpg" }
        ]
      },
      {
        "item_index": 1,
        "images": [
          { "index": 1, "imageKey": "uploads/item2_top.jpg" },
          { "index": 4, "imageKey": "uploads/item2_side.jpg" }
        ]
      },
      ...
    ]
    """
    try:
        if event["requestContext"]["http"]["method"] != "POST":
            return build_response(405, {"error": "Method not allowed."})

        body = json.loads(event.get("body", "{}"))
        images = body.get("images", [])
        num_items = body.get("num_items")
        views_per_item = body.get("views_per_item")

        if not images:
            return build_response(400, {"error": "No images provided."})
        if not num_items:
            return build_response(400, {"error": "num_items is required."})
        if not views_per_item:
            return build_response(400, {"error": "views_per_item is required."})

        # Validate that we have the expected number of images
        expected_images = num_items * views_per_item
        if len(images) != expected_images:
            return build_response(400, {
                "error": f"Expected {expected_images} images ({num_items} items × {views_per_item} views), but got {len(images)}."
            })

        # Group images by item index
        groups = {}
        for view_num in range(views_per_item):
            # For each view type (e.g. top view, then side view)
            view_offset = view_num * num_items
            
            for item_num in range(num_items):
                # Get the image for this item at this view
                img_idx = view_offset + item_num
                img_info = images[img_idx]
                
                if not img_info.get("s3Key"):
                    continue
                
                # Add to the appropriate group
                if item_num not in groups:
                    groups[item_num] = []
                groups[item_num].append({
                    "index": img_idx,
                    "imageKey": img_info["s3Key"]
                })

        # Convert to the JSON-friendly structure
        result = []
        for item_num, img_list in groups.items():
            result.append({
                "item_index": item_num,
                "images": sorted(img_list, key=lambda x: x["index"])
            })

        return build_response(200, result)

    except Exception as e:
        print(e)
        return build_response(500, {"error": "Internal server error", "detail": str(e)})

def build_response(status_code: int, body: Any):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }
