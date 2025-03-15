import json
import os
import boto3
import cv2 as cv
import numpy as np
import base64
from typing import Dict, Any, List

s3 = boto3.client('s3')
BUCKET_NAME = os.environ.get('BUCKET_NAME')

def lambda_handler(event, context):
    """
    POST /groupImages
    Expects a JSON body like:
    {
        "images": [
          { "s3Key": "uploads/tmp123.jpg" },
          { "s3Key": "uploads/tmp124.jpg" }
        ]
    }
    Returns something like:
    [
      {
        "marker_id": "group1",
        "images": [
          { "index": 0, "imageKey": "uploads/tmp123.jpg" },
          { "index": 1, "imageKey": "uploads/tmp124.jpg" }
        ]
      },
      ...
    ]
    (No additional marker-based metadata is parsed here.)
    """
    try:
        if event["requestContext"]["http"]["method"] != "POST":
            return build_response(405, {"error": "Method not allowed."})

        body = json.loads(event.get("body", "{}"))
        images = body.get("images", [])
        if not images:
            return build_response(400, {"error": "No images provided."})

        # We'll store: marker_id -> list of (index, imageKey)
        groups = {}

        # For each image, we detect the item marker (NOT other markers).
        for idx, img_info in enumerate(images):
            s3_key = img_info.get("s3Key")
            if not s3_key:
                continue

            # 1) Download the image from S3
            original_img = download_s3_image(BUCKET_NAME, s3_key)
            if original_img is None:
                continue

            # 2) Detect marker (item marker)
            marker_id = detect_item_marker(original_img)

            # 3) Group by marker_id
            if marker_id not in groups:
                groups[marker_id] = []
            groups[marker_id].append({"index": idx, "imageKey": s3_key})

        # Convert to the JSON-friendly structure
        result = []
        for marker, img_list in groups.items():
            result.append({
                "marker_id": marker,
                "images": img_list
            })

        return build_response(200, result)

    except Exception as e:
        print(e)
        return build_response(500, {"error": "Internal server error", "detail": str(e)})


def download_s3_image(bucket: str, key: str) -> np.ndarray:
    """
    Downloads an image from S3 and converts it to an OpenCV numpy array.
    Returns None on error.
    """
    try:
        response = s3.get_object(Bucket=bucket, Key=key)
        data = response['Body'].read()
        np_arr = np.frombuffer(data, np.uint8)
        image = cv.imdecode(np_arr, cv.IMREAD_COLOR)
        return image
    except Exception as e:
        print(f"Error downloading {key} from S3: {e}")
        return None

def detect_item_marker(image: np.ndarray) -> str:
    """
    Detects the 'item marker' in the image using OpenCV.
    Return a marker_id string, or 'unknown' if none found.
    Dummy placeholder for now, uses ArUco or other logic.
    """
    # Example ArUco detection
    dictionary = cv.aruco.getPredefinedDictionary(cv.aruco.DICT_4X4_250)
    parameters = cv.aruco.DetectorParameters()
    detector = cv.aruco.ArucoDetector(dictionary, parameters)

    gray = cv.cvtColor(image, cv.COLOR_BGR2GRAY)
    markerCorners, markerIds, _ = detector.detectMarkers(gray)

    if markerIds is not None and len(markerIds) > 0:
        # Just use the first marker ID
        return f"marker_{markerIds[0][0]}"
    else:
        return "unknown"

def build_response(status_code: int, body: Any):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }
