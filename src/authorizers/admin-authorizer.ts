import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDB } from 'aws-sdk';

const dynamo = new DynamoDB.DocumentClient();
const USERS_TABLE = process.env.USERS_TABLE!;

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  try {
    console.log('event', event);

    // Get the user ID from the JWT token
    const userId = event.requestContext.authorizer?.jwt.claims.sub;
    if (!userId) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthorized - No user ID found' })
      };
    }

    console.log('userId', userId);

    // Get user from DynamoDB
    const result = await dynamo.get({
      TableName: USERS_TABLE,
      Key: { user_id: userId }
    }).promise();

    const user = result.Item;
    if (!user) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthorized - User not found' })
      };
    }

    console.log('result', result);

    // Check if user is admin
    if (!user.is_admin) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Forbidden - Admin privileges required' })
      };
    }

    // User is admin, allow the request to proceed
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Authorized' })
    };
  } catch (error) {
    console.error('Admin authorizer error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
} 