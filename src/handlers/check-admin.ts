import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDB } from 'aws-sdk';
import { createLogger } from '../utils/logger';

const dynamo = new DynamoDB.DocumentClient();
const USERS_TABLE = process.env.USERS_TABLE!;

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  const log = createLogger(event);
  log.logRequest(event);
  
  try {
    // Get username from JWT claims (matches the user_id stored in create-user handler)
    // Cognito stores username in 'cognito:username' or 'username' claim
    // Note: We use username, not 'sub', because create-user stores user_id as userName
    const userId = event.requestContext.authorizer?.jwt.claims['cognito:username'] 
      || event.requestContext.authorizer?.jwt.claims.username;
    
    if (!userId) {
      log.warn('Unauthorized request - no userId in JWT claims');
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthorized' })
      };
    }

    log.info('Checking admin status', { userId });

    const result = await dynamo.get({
      TableName: USERS_TABLE,
      Key: { user_id: userId }
    }).promise();

    const user = result.Item;
    if (!user) {
      log.warn('User not found in database', { userId });
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'User not found' })
      };
    }

    log.info('Admin status check completed', { userId, isAdmin: user.is_admin || false });

    return {
      statusCode: 200,
      body: JSON.stringify({
        is_admin: user.is_admin || false,
        user_id: user.user_id,
        email: user.email
      })
    };
  } catch (error) {
    log.error('Error checking admin status', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
} 