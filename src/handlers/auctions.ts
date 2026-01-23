import { APIGatewayProxyEventV2WithJWTAuthorizer, Context } from 'aws-lambda';
import { DynamoDB, S3 } from 'aws-sdk';
import { createLogger } from '../utils/logger';
import { requireAdmin } from '../utils/admin-check';

const dynamo = new DynamoDB.DocumentClient();
const s3 = new S3();
const AUCTIONS_TABLE = process.env.AUCTIONS_TABLE!;
const ITEMS_TABLE = process.env.ITEMS_TABLE!;
const IMAGES_TABLE = process.env.IMAGES_TABLE!;
const BUCKET_NAME = process.env.BUCKET_NAME!;

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer, context: Context) {
  const log = createLogger(event, context);
  
  try {
    const { routeKey, pathParameters } = event;

    log.logRequest(event);


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

        log.info('Fetching auction with items', { auctionId });

        // 1. Fetch auction details
        const auctionResult = await dynamo.get({
            TableName: AUCTIONS_TABLE,
            Key: { auction_id: auctionId },
        }).promise();

        if (!auctionResult.Item) {
            return buildResponse(404, {error: 'Auction not found'});
        }
        const auction = auctionResult.Item;
        
        log.info('Auction found', { auctionId, auctionName: auction.name });

         // 2. Query items for this auction
        const itemsResult = await dynamo.query({
            TableName: ITEMS_TABLE,
            IndexName: "auctionIdIndex", // Secondary index for auction_id
            KeyConditionExpression: "auction_id = :auctionId",
            ExpressionAttributeValues: { ":auctionId": auctionId },
        }).promise();
    
        const items = itemsResult.Items || [];

        log.info('Items retrieved for auction', { auctionId, itemCount: items.length });
    
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
        
        log.info('Successfully fetched auction with items and images', { 
          auctionId, 
          itemCount: items.length,
          totalImages: items.reduce((sum: number, item: any) => sum + (item.images?.length || 0), 0)
        });

        return buildResponse(200, { auction, items });
    }

    // Admin routes require admin privileges
    if (routeKey === 'POST /admin/auctions' || routeKey === 'PUT /admin/auctions/{auctionId}' || routeKey === 'DELETE /admin/auctions/{auctionId}') {
      await requireAdmin(event);
    }

    if (routeKey === 'POST /auctions' || routeKey === 'POST /admin/auctions') {
      // Create an auction (regular or admin route)
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

    if (routeKey === 'PUT /auctions/{auctionId}' || routeKey === 'PUT /admin/auctions/{auctionId}') {
      // Update an auction (regular or admin route)
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

    if (routeKey === 'DELETE /auctions/{auctionId}' || routeKey === 'DELETE /admin/auctions/{auctionId}') {
      // Delete an auction (regular or admin route)
      if (!pathParameters?.auctionId) {
        return buildResponse(400, { error: 'Missing auctionId' });
      }
      await dynamo.delete({
        TableName: AUCTIONS_TABLE,
        Key: { auction_id: pathParameters.auctionId }
      }).promise();
      return buildResponse(200, { message: 'Auction deleted' });
    }

    if (routeKey === 'POST /auctions/{auctionId}/items') {
      // Associate items with an auction
      if (!event.body || !pathParameters?.auctionId) {
        return buildResponse(400, { error: 'Missing body or auctionId' });
      }

      const body = JSON.parse(event.body);
      const { item_ids } = body;
      const auctionId = pathParameters.auctionId;

      if (!Array.isArray(item_ids) || item_ids.length === 0) {
        return buildResponse(400, { error: 'item_ids array is required and must not be empty' });
      }

      // Check if auction exists
      const auctionCheck = await dynamo.get({
        TableName: AUCTIONS_TABLE,
        Key: { auction_id: auctionId }
      }).promise();

      if (!auctionCheck.Item) {
        return buildResponse(404, { error: 'Auction not found' });
      }

      // Update each item to associate it with the auction
      const now = new Date().toISOString();
      const updatePromises = item_ids.map(itemId => 
        dynamo.update({
          TableName: ITEMS_TABLE,
          Key: { item_id: itemId },
          UpdateExpression: 'SET auction_id = :auctionId, updated_at = :updatedAt',
          ExpressionAttributeValues: {
            ':auctionId': auctionId,
            ':updatedAt': now
          },
          ReturnValues: 'ALL_NEW'
        }).promise()
      );

      try {
        const results = await Promise.all(updatePromises);
        log.info('Items associated with auction', { auctionId, itemCount: item_ids.length });
        return buildResponse(200, { 
          message: 'Items associated with auction',
          items: results.map(result => result.Attributes)
        });
      } catch (error) {
        log.error('Failed to update items for auction', error, { auctionId, item_ids });
        return buildResponse(500, { error: 'Failed to update some items' });
      }
    }

    log.warn('Route not found', { routeKey });
    return buildResponse(404, { error: 'Route not found' });
  } catch (err) {
    log.error('Unhandled error in auctions handler', err);
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
