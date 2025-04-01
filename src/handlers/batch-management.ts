import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SecretsManager } from 'aws-sdk';

const secretsManager = new SecretsManager();
const OPENAI_SECRET_ARN = process.env.OPENAI_SECRET_ARN || '';

let cachedApiKey: string | undefined;

interface BatchRequest {
  custom_id: string;
  method: string;
  url: string;
  body: any;
}

interface BatchResponse {
  id: string;
  custom_id: string;
  response: {
    status_code: number;
    request_id: string;
    body: any;
  } | null;
  error: {
    code: string;
    message: string;
  } | null;
}

interface Batch {
  id: string;
  object: string;
  endpoint: string;
  errors: any;
  input_file_id: string;
  completion_window: string;
  status: string;
  output_file_id: string | null;
  error_file_id: string | null;
  created_at: number;
  in_progress_at: number | null;
  expires_at: number | null;
  finalizing_at: number | null;
  completed_at: number | null;
  failed_at: number | null;
  expired_at: number | null;
  cancelling_at: number | null;
  cancelled_at: number | null;
  request_counts: {
    total: number;
    completed: number;
    failed: number;
  };
  metadata: Record<string, string> | null;
}

interface BatchListResponse {
  object: string;
  data: Batch[];
  first_id: string;
  last_id: string;
  has_more: boolean;
}

async function getOpenAIKey(): Promise<string> {
  if (cachedApiKey !== undefined) {
    return cachedApiKey;
  }

  const response = await secretsManager.getSecretValue({
    SecretId: OPENAI_SECRET_ARN
  }).promise();

  if (!response.SecretString) {
    throw new Error('No API key found in secret');
  }

  const secret = JSON.parse(response.SecretString);
  if (!secret.api_key) {
    throw new Error('api_key not found in secret');
  }

  cachedApiKey = secret.api_key;
  return secret.api_key;
}

async function listBatches(limit: number = 20, after?: string): Promise<BatchListResponse> {
  const apiKey = await getOpenAIKey();
  
  const url = new URL('https://api.openai.com/v1/batches');
  url.searchParams.append('limit', limit.toString());
  if (after) {
    url.searchParams.append('after', after);
  }

  const response = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to list batches: ${response.statusText}`);
  }

  return await response.json();
}

async function getBatch(batchId: string): Promise<Batch> {
  const apiKey = await getOpenAIKey();
  
  const response = await fetch(`https://api.openai.com/v1/batches/${batchId}`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to get batch: ${response.statusText}`);
  }

  return await response.json();
}

async function cancelBatch(batchId: string): Promise<Batch> {
  const apiKey = await getOpenAIKey();
  
  const response = await fetch(`https://api.openai.com/v1/batches/${batchId}/cancel`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to cancel batch: ${response.statusText}`);
  }

  return await response.json();
}

async function getBatchResults(batchId: string): Promise<BatchResponse[]> {
  const batch = await getBatch(batchId);
  
  if (!batch.output_file_id) {
    throw new Error('Batch has no output file');
  }

  const apiKey = await getOpenAIKey();
  
  const response = await fetch(`https://api.openai.com/v1/files/${batch.output_file_id}/content`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to get batch results: ${response.statusText}`);
  }

  const content = await response.text();
  return content.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    if (event.requestContext.http.method !== 'GET' && event.requestContext.http.method !== 'POST') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }

    // Check which operation we're performing based on the path
    const path = event.requestContext.http.path;
    
    if (path.endsWith('/batches')) {
      // List batches
      const queryParams = event.queryStringParameters || {};
      const limit = parseInt(queryParams.limit || '20', 10);
      const after = queryParams.after;
      
      const batches = await listBatches(limit, after);
      return {
        statusCode: 200,
        body: JSON.stringify(batches)
      };
    } else if (path.match(/\/batches\/[^\/]+$/)) {
      // Get batch details
      const batchId = path.split('/').pop()!;
      const batch = await getBatch(batchId);
      return {
        statusCode: 200,
        body: JSON.stringify(batch)
      };
    } else if (path.match(/\/batches\/[^\/]+\/results$/)) {
      // Get batch results
      const batchId = path.split('/')[path.split('/').length - 2];
      const results = await getBatchResults(batchId);
      return {
        statusCode: 200,
        body: JSON.stringify(results)
      };
    } else if (path.match(/\/batches\/[^\/]+\/cancel$/)) {
      // Cancel batch
      const batchId = path.split('/')[path.split('/').length - 2];
      const batch = await cancelBatch(batchId);
      return {
        statusCode: 200,
        body: JSON.stringify(batch)
      };
    } else {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Unknown operation' })
      };
    }

  } catch (error: unknown) {
    console.error(error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal server error',
        detail: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
} 