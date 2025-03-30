import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDB } from 'aws-sdk';

const dynamo = new DynamoDB.DocumentClient();
const USERS_TABLE = process.env.USERS_TABLE!;

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  try {
    const userId = event.requestContext.authorizer?.jwt.claims.sub;
    if (!userId) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthorized' })
      };
    }

    const result = await dynamo.get({
      TableName: USERS_TABLE,
      Key: { user_id: userId }
    }).promise();

    const user = result.Item;
    if (!user) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'User not found' })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        is_admin: user.is_admin || false,
        user_id: user.user_id,
        email: user.email
      })
    };
  } catch (error) {
    console.error('Error checking admin status:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
} 