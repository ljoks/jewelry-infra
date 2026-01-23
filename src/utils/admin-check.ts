/**
 * Shared utility for checking admin status
 * Used across all admin handlers for consistent authorization
 */

import { DynamoDB } from 'aws-sdk';
import { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

const dynamo = new DynamoDB.DocumentClient();
const USERS_TABLE = process.env.USERS_TABLE!;

export interface AdminCheckResult {
  isAdmin: boolean;
  userId: string;
  user?: any;
}

/**
 * Extract userId from event (supports both Cognito JWT and Lambda authorizer)
 */
export function getUserIdFromEvent(event: APIGatewayProxyEventV2WithJWTAuthorizer | any): string | null {
  // Try Lambda authorizer context first (for admin routes that might use it)
  const authorizer = event.requestContext?.authorizer as any;
  if (authorizer?.lambda?.userId) {
    return authorizer.lambda.userId;
  }
  
  // Try Cognito JWT claims (standard approach)
  if (authorizer?.jwt?.claims) {
    return authorizer.jwt.claims['cognito:username'] 
      || authorizer.jwt.claims.username
      || authorizer.jwt.claims.sub
      || null;
  }
  
  return null;
}

/**
 * Check if the current user is an admin
 * Returns null if user not found or not authenticated
 */
export async function checkAdminStatus(
  event: APIGatewayProxyEventV2WithJWTAuthorizer | any
): Promise<AdminCheckResult | null> {
  const userId = getUserIdFromEvent(event);
  
  if (!userId) {
    return null;
  }

  try {
    const result = await dynamo.get({
      TableName: USERS_TABLE,
      Key: { user_id: userId }
    }).promise();

    const user = result.Item;
    if (!user) {
      return null;
    }

    return {
      isAdmin: user.is_admin === true,
      userId: userId,
      user: user
    };
  } catch (error) {
    console.error('Error checking admin status:', error);
    return null;
  }
}

/**
 * Require admin status - throws error if user is not admin
 * Use this in admin handlers to enforce authorization
 */
export async function requireAdmin(
  event: APIGatewayProxyEventV2WithJWTAuthorizer | any
): Promise<AdminCheckResult> {
  const result = await checkAdminStatus(event);
  
  if (!result) {
    throw new Error('Unauthorized - User not found or not authenticated');
  }
  
  if (!result.isAdmin) {
    throw new Error('Forbidden - Admin privileges required');
  }
  
  return result;
}

