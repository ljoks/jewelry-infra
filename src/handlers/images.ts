import { APIGatewayProxyEventV2WithJWTAuthorizer, Context } from 'aws-lambda';
import { DynamoDB, S3 } from 'aws-sdk';

const dynamo = new DynamoDB.DocumentClient();
const s3 = new S3();

const IMAGES_TABLE = process.env.IMAGES_TABLE!;
const ITEMS_TABLE = process.env.ITEMS_TABLE!;
const BUCKET_NAME = process.env.BUCKET_NAME!;

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer, context: Context) {
  try {
    const { routeKey, pathParameters } = event;
    console.log(routeKey);

    if (routeKey === 'POST /images') {
      /**
       * Create a presigned URL for uploading a new image, tied to an auction.
       * Expects JSON body like:
       * {
       *   "image_id": "img123",
       *   "item_id": "itemA",
       *   "auction_id": "auctionX"
       * }
       */
      if (!event.body) {
        return buildResponse(400, { error: 'Request body is required.' });
      }

      const body = JSON.parse(event.body);
      const { image_id, item_id, auction_id } = body;

      // Basic validation
      if (!image_id || !item_id || !auction_id) {
        return buildResponse(400, {
          error: 'image_id, item_id, and auction_id are required.'
        });
      }

      // Check if the item exists and belongs to the same auction_id
      const itemCheck = await dynamo.get({
        TableName: ITEMS_TABLE,
        Key: { item_id }
      }).promise();

      if (!itemCheck.Item) {
        return buildResponse(400, {
          error: `Item ${item_id} not found.`
        });
      }

      // Optionally verify the item references the same auction_id (if stored in the Items table)
      if (itemCheck.Item.auction_id !== auction_id) {
        return buildResponse(400, {
          error: `Item ${item_id} belongs to auction ${itemCheck.Item.auction_id}, not ${auction_id}.`
        });
      }

      // Generate the S3 key with auction_id in the path
      const s3KeyOriginal = `original/${auction_id}/${image_id}.jpg`;

      // Generate a presigned URL to PUT the image to S3
      const presignedUrl = await s3.getSignedUrlPromise('putObject', {
        Bucket: BUCKET_NAME,
        Key: s3KeyOriginal,
        Expires: 60 * 5, // 5 minutes
        ContentType: 'image/jpeg',
      });

      // Store the image reference in DynamoDB
      const now = new Date().toISOString();
      await dynamo.put({
        TableName: IMAGES_TABLE,
        Item: {
          image_id,
          item_id,
          auction_id,        // store the auction ID for direct reference
          s3_key_original: s3KeyOriginal,
          created_at: now
        },
      }).promise();

      return buildResponse(201, {
        message: 'Presigned URL generated',
        uploadUrl: presignedUrl,
        image_id,
        auction_id,
      });
    }

    if (routeKey === 'GET /images/{imageId}') {
      /**
       * GET /images/{imageId}
       * Retrieves the image record, optionally returning a presigned GET URL for viewing.
       */
      if (!pathParameters?.imageId) {
        return buildResponse(400, { error: 'Missing imageId path parameter.' });
      }

      const resp = await dynamo.get({
        TableName: IMAGES_TABLE,
        Key: { image_id: pathParameters.imageId }
      }).promise();
      if (!resp.Item) {
        return buildResponse(404, { error: 'Image not found.' });
      }

      // Optional: create a presigned GET URL for the original image
      const getUrl = await s3.getSignedUrlPromise('getObject', {
        Bucket: BUCKET_NAME,
        Key: resp.Item.s3_key_original,
        Expires: 60 * 5,
      });

      return buildResponse(200, {
        ...resp.Item,
        viewUrl: getUrl
      });
    }

    if (routeKey === 'DELETE /images/{imageId}') {
      /**
       * DELETE /images/{imageId}
       * Removes the image from DynamoDB, and optionally from S3 as well.
       */
      if (!pathParameters?.imageId) {
        return buildResponse(400, { error: 'Missing imageId path parameter.' });
      }

      // Get image info first
      const resp = await dynamo.get({
        TableName: IMAGES_TABLE,
        Key: { image_id: pathParameters.imageId }
      }).promise();
      if (!resp.Item) {
        return buildResponse(404, { error: 'Image not found.' });
      }

      // Remove from DynamoDB
      await dynamo.delete({
        TableName: IMAGES_TABLE,
        Key: { image_id: pathParameters.imageId }
      }).promise();

      // Remove from S3
      await s3.deleteObject({
        Bucket: BUCKET_NAME,
        Key: resp.Item.s3_key_original
      }).promise();

      return buildResponse(200, { message: 'Image deleted' });
    }

    if (routeKey === 'POST /images/getPresignedUrl') {
        /**
         * POST /images/getPresignedUrl
         * Generates a presignedUrl for the frontend to be able to upload directly to s3
         */
        if (!event.body) {
            return buildResponse(400, { error: 'Request body is required.' });
        }

        const body = JSON.parse(event.body);
        const { fileName, fileType } = body;

        // Basic validation
        if (!fileName || !fileType ) {
            return buildResponse(400, {
                error: 'fileName and fileType are required.'
            });
        }

        // Define unique path (temp storage)
        const s3Key = `uploads/tmp/${Date.now()}-${fileName}`;

        // Generate presigned URL (expires in 15 min)
        const presignedUrl = s3.getSignedUrl("putObject", {
            Bucket: BUCKET_NAME,
            Key: s3Key,
            Expires: 900, // 15 minutes
            ContentType: fileType
        });

        return buildResponse(200, { presignedUrl, s3Key });
    }

    return buildResponse(404, { error: 'Route not found.' });
  } catch (err) {
    console.error(err);
    return buildResponse(500, { error: 'Internal Server Error' });
  }

}

function buildResponse(statusCode: number, data: any) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}
