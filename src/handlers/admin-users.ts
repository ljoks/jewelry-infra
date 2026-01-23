import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { DynamoDB } from 'aws-sdk';
import { createLogger } from '../utils/logger';
import { requireAdmin, getUserIdFromEvent } from '../utils/admin-check';

const dynamo = new DynamoDB.DocumentClient();
const USERS_TABLE = process.env.USERS_TABLE!;

function buildResponse(statusCode: number, data: any): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  context: Context
): Promise<APIGatewayProxyResultV2> {
  const log = createLogger(event, context);
  log.logRequest(event);

  try {
    const { routeKey, pathParameters } = event;

    // Require admin access for all operations
    const adminCheck = await requireAdmin(event);
    const currentUserId = adminCheck.userId;

    if (routeKey === 'GET /admin/users') {
      log.info('Fetching all users', { currentUserId });

      // Scan all users (for admin panel)
      const result = await dynamo.scan({
        TableName: USERS_TABLE
      }).promise();

      const users = (result.Items || []).map(user => ({
        user_id: user.user_id,
        email: user.email,
        is_admin: user.is_admin || false,
        created_at: user.created_at,
        updated_at: user.updated_at
      }));

      log.info('Users fetched successfully', { count: users.length });
      return buildResponse(200, { users, count: users.length });
    }

    if (routeKey === 'PUT /admin/users/{userId}') {
      if (!pathParameters?.userId) {
        log.warn('PUT /admin/users/{userId} called without userId');
        return buildResponse(400, { error: 'Missing userId' });
      }

      if (!event.body) {
        log.warn('PUT /admin/users/{userId} called without body');
        return buildResponse(400, { error: 'Request body required' });
      }

      const targetUserId = pathParameters.userId;
      log.info('Updating user', { currentUserId, targetUserId });

      let updateBody;
      try {
        updateBody = JSON.parse(event.body);
      } catch (parseError) {
        log.warn('Invalid JSON in request body');
        return buildResponse(400, { error: 'Invalid JSON in request body' });
      }

      // Only allow updating is_admin field
      if (updateBody.is_admin === undefined) {
        log.warn('No updatable fields provided');
        return buildResponse(400, { error: 'No updatable fields provided' });
      }

      const now = new Date().toISOString();
      const updateExp = ['updated_at = :updated_at'];
      const attrValues: any = { ':updated_at': now };
      const attrNames: any = {};

      if (updateBody.is_admin !== undefined) {
        updateExp.push('#isAdmin = :isAdmin');
        attrNames['#isAdmin'] = 'is_admin';
        attrValues[':isAdmin'] = updateBody.is_admin === true;
      }

      await dynamo.update({
        TableName: USERS_TABLE,
        Key: { user_id: targetUserId },
        UpdateExpression: 'SET ' + updateExp.join(', '),
        ExpressionAttributeNames: attrNames,
        ExpressionAttributeValues: attrValues,
        ReturnValues: 'ALL_NEW'
      }).promise();

      log.info('User updated successfully', { currentUserId, targetUserId });
      return buildResponse(200, { message: 'User updated' });
    }

    if (routeKey === 'DELETE /admin/users/{userId}') {
      if (!pathParameters?.userId) {
        log.warn('DELETE /admin/users/{userId} called without userId');
        return buildResponse(400, { error: 'Missing userId' });
      }

      const targetUserId = pathParameters.userId;
      
      // Prevent self-deletion
      if (targetUserId === currentUserId) {
        log.warn('Attempted self-deletion', { currentUserId });
        return buildResponse(400, { error: 'Cannot delete your own account' });
      }

      log.info('Deleting user', { currentUserId, targetUserId });

      await dynamo.delete({
        TableName: USERS_TABLE,
        Key: { user_id: targetUserId }
      }).promise();

      log.info('User deleted successfully', { currentUserId, targetUserId });
      return buildResponse(200, { message: 'User deleted' });
    }

    log.warn('Route not found', { routeKey });
    return buildResponse(404, { error: 'Route not found' });
  } catch (error) {
    log.error('Unhandled error in admin-users handler', error);
    
    if (error instanceof Error) {
      if (error.message === 'Unauthorized - User not found or not authenticated') {
        return buildResponse(401, { error: 'Unauthorized' });
      }
      if (error.message === 'Forbidden - Admin privileges required') {
        return buildResponse(403, { error: 'Forbidden - Admin privileges required' });
      }
    }
    
    return buildResponse(500, { error: 'Internal server error' });
  }
}

