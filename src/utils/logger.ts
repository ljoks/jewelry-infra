/**
 * Structured logger utility for Lambda handlers
 * Provides consistent logging format with context for debugging
 */

export interface LogContext {
  requestId?: string;
  routeKey?: string;
  path?: string;
  method?: string;
  userId?: string;
  [key: string]: any;
}

export class Logger {
  private context: LogContext = {};

  /**
   * Initialize logger with request context
   */
  init(event: any, lambdaContext?: any): void {
    this.context = {
      requestId: lambdaContext?.awsRequestId || event?.requestContext?.requestId || 'unknown',
      routeKey: event?.routeKey,
      path: event?.requestContext?.http?.path || event?.rawPath,
      method: event?.requestContext?.http?.method || event?.httpMethod,
      userId: event?.requestContext?.authorizer?.jwt?.claims?.sub,
    };
  }

  /**
   * Format message with context
   */
  private formatMessage(level: string, message: string, data?: any): string {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      requestId: this.context.requestId,
      routeKey: this.context.routeKey,
      path: this.context.path,
      method: this.context.method,
      userId: this.context.userId,
      message,
      ...(data && { data }),
    };
    return JSON.stringify(logEntry);
  }

  /**
   * Log informational message
   */
  info(message: string, data?: any): void {
    console.log(this.formatMessage('INFO', message, data));
  }

  /**
   * Log warning message
   */
  warn(message: string, data?: any): void {
    console.warn(this.formatMessage('WARN', message, data));
  }

  /**
   * Log error with full context and stack trace
   */
  error(message: string, error?: any, data?: any): void {
    const errorData = {
      ...data,
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
      } : error,
    };
    console.error(this.formatMessage('ERROR', message, errorData));
  }

  /**
   * Log debug message (useful for development)
   */
  debug(message: string, data?: any): void {
    if (process.env.LOG_LEVEL === 'DEBUG') {
      console.log(this.formatMessage('DEBUG', message, data));
    }
  }

  /**
   * Log handler entry point
   */
  logRequest(event: any): void {
    this.info('Handler invoked', {
      queryStringParameters: event.queryStringParameters,
      pathParameters: event.pathParameters,
      hasBody: !!event.body,
      bodyLength: event.body?.length,
    });
  }

  /**
   * Log handler response
   */
  logResponse(statusCode: number, body?: any): void {
    this.info('Handler response', {
      statusCode,
      bodyLength: typeof body === 'string' ? body.length : JSON.stringify(body)?.length,
    });
  }

  /**
   * Log DynamoDB operation
   */
  logDbOperation(operation: string, table: string, params?: any): void {
    this.debug(`DynamoDB ${operation}`, { table, params });
  }

  /**
   * Log S3 operation
   */
  logS3Operation(operation: string, bucket: string, key?: string): void {
    this.debug(`S3 ${operation}`, { bucket, key });
  }
}

// Export singleton instance
export const logger = new Logger();

// Export function to create new logger per request (recommended for concurrent handlers)
export function createLogger(event: any, context?: any): Logger {
  const log = new Logger();
  log.init(event, context);
  return log;
}

