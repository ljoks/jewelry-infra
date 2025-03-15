import { APIGatewayProxyEventV2WithJWTAuthorizer, Context } from 'aws-lambda';
import { DynamoDB } from 'aws-sdk';

const dynamo = new DynamoDB.DocumentClient();
const ITEMS_TABLE = process.env.ITEMS_TABLE!;
const AUCTIONS_TABLE = process.env.AUCTIONS_TABLE!;

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
      const { item_id, auction_id, marker_id, item_title, description, created_by } = body;

      // Validate required fields
      if (!item_id || !auction_id) {
        return buildResponse(400, { error: 'item_id, auction_id are required' });
      }

      // (Optional) Check if the auction exists
      const auctionCheck = await dynamo.get({
        TableName: AUCTIONS_TABLE,
        Key: { auction_id },
      }).promise();
      if (!auctionCheck.Item) {
        return buildResponse(400, { error: `Auction ${auction_id} does not exist` });
      }

      const now = new Date().toISOString();
      await dynamo.put({
        TableName: ITEMS_TABLE,
        Item: {
          item_id,
          auction_id,
          marker_id,
          item_title,
          description,
          created_by,
          created_at: now,
          updated_at: now
        },
      }).promise();

      return buildResponse(201, { message: 'Item created', item_id });
    }

    if (routeKey === 'GET /items/{itemId}') {
      // Get an item
      if (!pathParameters?.itemId) {
        return buildResponse(400, { error: 'Missing itemId' });
      }
      const resp = await dynamo.get({
        TableName: ITEMS_TABLE,
        Key: { item_id: pathParameters.itemId }
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

      if (updateExp.length === 0) {
        return buildResponse(400, { error: 'No updatable fields provided' });
      }
      updateExp.push('updated_at = :updated_at');

      await dynamo.update({
        TableName: ITEMS_TABLE,
        Key: { item_id: pathParameters.itemId },
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
        Key: { item_id: pathParameters.itemId }
      }).promise();
      return buildResponse(200, { message: 'Item deleted' });
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
