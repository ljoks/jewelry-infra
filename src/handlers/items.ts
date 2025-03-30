import { APIGatewayProxyEventV2WithJWTAuthorizer, Context } from 'aws-lambda';
import { DynamoDB } from 'aws-sdk';

const dynamo = new DynamoDB.DocumentClient();
const ITEMS_TABLE = process.env.ITEMS_TABLE!;
const AUCTIONS_TABLE = process.env.AUCTIONS_TABLE!;
const IMAGES_TABLE = process.env.IMAGES_TABLE!;
const COUNTER_TABLE = process.env.COUNTER_TABLE!;

async function generateSequentialId(): Promise<number> {
  try {
    // Update the counter atomically and get the new value
    const response = await dynamo.update({
      TableName: COUNTER_TABLE,
      Key: {
        counter_name: 'GLOBAL',
        counter_type: 'ITEM'
      },
      UpdateExpression: 'ADD #count :inc',
      ExpressionAttributeNames: {
        '#count': 'count'
      },
      ExpressionAttributeValues: {
        ':inc': 1
      },
      ReturnValues: 'UPDATED_NEW'
    }).promise();
    
    console.log('Generate Sequential ID response', response);
    
    // Get the new count and return it as a number
    return response.Attributes?.count || 1;
  } catch (error) {
    console.error('Error generating sequential ID:', error);
    throw error;
  }
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer, context: Context) {
  try {
    const { routeKey, pathParameters } = event;
    console.log(routeKey);

    if (routeKey === 'POST /items') {
      // Create a new item
      if (!event.body) {
        return buildResponse(400, { error: 'Request body required' });
      }
      const body = JSON.parse(event.body);
      const { auction_id, marker_id, item_title, description, created_by } = body;

      // Generate sequential ID for the item
      const item_id = await generateSequentialId();

      const now = new Date().toISOString();
      await dynamo.put({
        TableName: ITEMS_TABLE,
        Item: {
          item_id,
          auction_id: auction_id || null, // Make auction_id optional
          marker_id,
          item_title,
          description,
          created_by,
          created_at: now,
          updated_at: now
        },
      }).promise();

      console.log('Item created', item_id);

      return buildResponse(201, { message: 'Item created', item_id });
    }

    if (routeKey === 'GET /items/{itemId}') {
      // Get an item
      if (!pathParameters?.itemId) {
        return buildResponse(400, { error: 'Missing itemId' });
      }
      const resp = await dynamo.get({
        TableName: ITEMS_TABLE,
        Key: { item_id: parseInt(pathParameters.itemId, 10) }
      }).promise();
      return buildResponse(200, resp.Item);
    }

    if (routeKey === 'PUT /items/{itemId}') {
      // Update an item
      if (!event.body || !pathParameters?.itemId) {
        return buildResponse(400, { error: 'Missing body or itemId' });
      }
      const updateBody = JSON.parse(event.body);
      const now = new Date().toISOString();

      const updateExp = [];
      const attrValues: any = { ':updated_at': now };
      const attrNames: any = {};

      if (updateBody.item_title) {
        updateExp.push('#title = :title');
        attrNames['#title'] = 'item_title';
        attrValues[':title'] = updateBody.item_title;
      }
      if (updateBody.description !== undefined) {
        updateExp.push('#desc = :desc');
        attrNames['#desc'] = 'description';
        attrValues[':desc'] = updateBody.description;
      }
      if (updateBody.images !== undefined) {
        updateExp.push('#images = :images');
        attrNames['#images'] = 'images';
        attrValues[':images'] = updateBody.images;
      }

      if (updateExp.length === 0) {
        return buildResponse(400, { error: 'No updatable fields provided' });
      }
      updateExp.push('updated_at = :updated_at');

      await dynamo.update({
        TableName: ITEMS_TABLE,
        Key: { item_id: parseInt(pathParameters.itemId, 10) },
        UpdateExpression: 'SET ' + updateExp.join(', '),
        ExpressionAttributeNames: attrNames,
        ExpressionAttributeValues: attrValues,
      }).promise();

      return buildResponse(200, { message: 'Item updated' });
    }

    if (routeKey === 'DELETE /items/{itemId}') {
      // Delete an item
      if (!pathParameters?.itemId) {
        return buildResponse(400, { error: 'Missing itemId' });
      }
      await dynamo.delete({
        TableName: ITEMS_TABLE,
        Key: { item_id: parseInt(pathParameters.itemId, 10) }
      }).promise();
      return buildResponse(200, { message: 'Item deleted' });
    }

    if (routeKey === 'GET /items') {
      // Get all items with optional sorting
      const queryParams = event.queryStringParameters || {};
      const sortBy = queryParams.sortBy || 'price'; // default sort by price
      const sortOrder = queryParams.sortOrder || 'desc'; // default highest first
      const auctionId = queryParams.auctionId; // optional filter by auction

      let dbQuery;

      if (auctionId) {
        // If filtering by auction, use query with GSI
        dbQuery = {
          TableName: ITEMS_TABLE,
          IndexName: 'auctionIdIndex',
          KeyConditionExpression: 'auction_id = :auctionId',
          ExpressionAttributeValues: {
            ':auctionId': auctionId
          }
        };
      } else {
        // Otherwise, scan all items
        dbQuery = {
          TableName: ITEMS_TABLE
        };
      }

      const data = await dynamo[auctionId ? 'query' : 'scan'](dbQuery).promise();
      let items = data.Items || [];

      // Fetch images for each item
      for (let item of items) {
        const imagesResult = await dynamo.query({
          TableName: IMAGES_TABLE,
          IndexName: 'itemIdIndex',
          KeyConditionExpression: 'item_id = :itemId',
          ExpressionAttributeValues: { ':itemId': item.item_id }
        }).promise();

        // Add the first image as the primary display image
        if (imagesResult.Items && imagesResult.Items.length > 0) {
          item.primaryImage = imagesResult.Items[0].s3_key_original;
        }
        
        // Add all images to the item
        item.images = imagesResult.Items || [];
      }

      // Sort items
      items.sort((a, b) => {
        const aValue = a[sortBy];
        const bValue = b[sortBy];

        if (typeof aValue === 'number' && typeof bValue === 'number') {
          return sortOrder === 'desc' ? bValue - aValue : aValue - bValue;
        }
        
        if (typeof aValue === 'string' && typeof bValue === 'string') {
          return sortOrder === 'desc' 
            ? bValue.localeCompare(aValue) 
            : aValue.localeCompare(bValue);
        }

        // If values are undefined or mixed types, push them to the end
        if (aValue === undefined) return 1;
        if (bValue === undefined) return -1;
        return 0;
      });

      return buildResponse(200, {
        items,
        count: items.length,
        sortBy,
        sortOrder
      });
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
