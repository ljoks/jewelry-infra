import { APIGatewayProxyEventV2WithJWTAuthorizer, Context } from 'aws-lambda';
import { DynamoDB, S3 } from 'aws-sdk';

const dynamo = new DynamoDB.DocumentClient();
const s3 = new S3();
const AUCTIONS_TABLE = process.env.AUCTIONS_TABLE!;
const ITEMS_TABLE = process.env.ITEMS_TABLE!;
const IMAGES_TABLE = process.env.IMAGES_TABLE!;
const BUCKET_NAME = process.env.BUCKET_NAME!;

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer, context: Context) {
  try {
    const { routeKey, pathParameters } = event;

    console.log("Full Event:", JSON.stringify(event, null, 2));
    console.log(routeKey);


    if (routeKey === 'GET /auctions') {
      // GET /auctions => list all
      const data = await dynamo.scan({ TableName: AUCTIONS_TABLE }).promise();
      return buildResponse(200, data.Items);
    }

    if (routeKey === 'GET /auctions/{auctionId}') {
      // GET /auctions/{auctionId}
      if (!pathParameters?.auctionId) {
        return buildResponse(400, { error: 'Missing auctionId' });
      }
      const resp = await dynamo.get({
        TableName: AUCTIONS_TABLE,
        Key: { auction_id: pathParameters.auctionId }
      }).promise();
      return buildResponse(200, resp.Item);
    }

    if(routeKey === 'GET /auctions/{auctionId}/items') {
        /*
            GET /auctions/{auctionId}/items
            Fetch auction details from AuctionsTable (Primary Key: auction_id).
            Query items from ItemsTable using auction_id as a secondary index.
            Retrieve images from ImagesTable based on item_id.
            Generate temporary S3 signed URLs for the cropped images.
        */
        if (!pathParameters?.auctionId) {
            return buildResponse(400, { error: 'Missing auctionId' });
        }

        const auctionId = pathParameters.auctionId;

        console.log("auctionId: " + auctionId);

        // 1. Fetch auction details
        const auctionResult = await dynamo.get({
            TableName: AUCTIONS_TABLE,
            Key: { auction_id: auctionId },
        }).promise();

        if (!auctionResult.Item) {
            return buildResponse(404, {error: 'Auction not found'});
        }
        const auction = auctionResult.Item;
        
        console.log("auction: " + auction);

         // 2. Query items for this auction
        const itemsResult = await dynamo.query({
            TableName: ITEMS_TABLE,
            IndexName: "auctionIdIndex", // Secondary index for auction_id
            KeyConditionExpression: "auction_id = :auctionId",
            ExpressionAttributeValues: { ":auctionId": auctionId },
        }).promise();
    
        const items = itemsResult.Items || [];

        console.log("items: " + items);
    
        // 3. Fetch images for each item
        for (let item of items) {
            const imagesResult = await dynamo.query({
                TableName: IMAGES_TABLE,
                IndexName: 'itemIdIndex',
                KeyConditionExpression: "item_id = :itemId",
                ExpressionAttributeValues: { ":itemId": item.item_id },
            }).promise();
            
            // Convert stored S3 keys into signed URLs for secure frontend access
            item.images = imagesResult.Items?.map(img => ({
                imageId: img.image_id,
                s3Key: img.s3_key_original,
                // signedUrl: s3.getSignedUrl("getObject", {
                //     Bucket: BUCKET_NAME,
                //     Key: img.s3_key_original,
                //     Expires: 900, // 15 min access
                // }),
            })) || [];
        }
        
        console.log("items: " + items);

        return buildResponse(200, { auction, items });
    }

    if (routeKey === 'POST /auctions') {
      // Create an auction
      if (!event.body) {
        return buildResponse(400, { error: 'Body is required' });
      }
      const body = JSON.parse(event.body);
      const { auction_id, name, start_date, end_date, created_by } = body;

      // Minimal validation
      if (!auction_id || !name) {
        return buildResponse(400, { error: 'auction_id and name are required' });
      }

      const now = new Date().toISOString();
      await dynamo.put({
        TableName: AUCTIONS_TABLE,
        Item: {
          auction_id,
          name,
          start_date,
          end_date,
          created_by,
          created_at: now,
          updated_at: now
        }
      }).promise();

      return buildResponse(201, { message: 'Auction created', auction_id });
    }

    if (routeKey === 'PUT /auctions/{auctionId}') {
      // Update an auction
      if (!event.body || !pathParameters?.auctionId) {
        return buildResponse(400, { error: 'Missing body or auctionId' });
      }
      const updateBody = JSON.parse(event.body);
      const now = new Date().toISOString();

      await dynamo.update({
        TableName: AUCTIONS_TABLE,
        Key: { auction_id: pathParameters.auctionId },
        UpdateExpression: `
          SET #name = :name,
              start_date = :start_date,
              end_date = :end_date,
              updated_at = :updated_at
        `,
        ExpressionAttributeNames: {
          '#name': 'name'
        },
        ExpressionAttributeValues: {
          ':name': updateBody.name,
          ':start_date': updateBody.start_date,
          ':end_date': updateBody.end_date,
          ':updated_at': now
        }
      }).promise();

      return buildResponse(200, { message: 'Auction updated' });
    }

    if (routeKey === 'DELETE /auctions/{auctionId}') {
      // Delete an auction
      if (!pathParameters?.auctionId) {
        return buildResponse(400, { error: 'Missing auctionId' });
      }
      await dynamo.delete({
        TableName: AUCTIONS_TABLE,
        Key: { auction_id: pathParameters.auctionId }
      }).promise();
      return buildResponse(200, { message: 'Auction deleted' });
    }

    return buildResponse(404, { error: 'Route not found' });
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
