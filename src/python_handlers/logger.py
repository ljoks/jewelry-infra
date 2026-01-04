"""
Structured logger utility for Lambda handlers
Provides consistent logging format with context for debugging
"""

import json
import logging
import traceback
from datetime import datetime
from typing import Any, Dict, Optional


class Logger:
    """Structured logger for Lambda handlers with JSON output"""
    
    def __init__(self):
        self.context: Dict[str, Any] = {}
        self._logger = logging.getLogger()
        self._logger.setLevel(logging.INFO)
    
    def init(self, event: Dict[str, Any], lambda_context: Any = None) -> None:
        """Initialize logger with request context"""
        request_context = event.get('requestContext', {})
        http_context = request_context.get('http', {})
        
        self.context = {
            'requestId': (
                getattr(lambda_context, 'aws_request_id', None) or 
                request_context.get('requestId', 'unknown')
            ),
            'path': http_context.get('path') or event.get('rawPath'),
            'method': http_context.get('method'),
        }
    
    def _format_message(self, level: str, message: str, data: Optional[Dict] = None) -> str:
        """Format message with context as JSON"""
        log_entry = {
            'timestamp': datetime.utcnow().isoformat() + 'Z',
            'level': level,
            'requestId': self.context.get('requestId'),
            'path': self.context.get('path'),
            'method': self.context.get('method'),
            'message': message,
        }
        
        if data:
            log_entry['data'] = data
            
        return json.dumps(log_entry, default=str)
    
    def info(self, message: str, data: Optional[Dict] = None) -> None:
        """Log informational message"""
        print(self._format_message('INFO', message, data))
    
    def warn(self, message: str, data: Optional[Dict] = None) -> None:
        """Log warning message"""
        print(self._format_message('WARN', message, data))
    
    def error(self, message: str, error: Optional[Exception] = None, data: Optional[Dict] = None) -> None:
        """Log error with full context and stack trace"""
        error_data = dict(data) if data else {}
        
        if error:
            error_data['error'] = {
                'type': type(error).__name__,
                'message': str(error),
                'traceback': traceback.format_exc()
            }
        
        print(self._format_message('ERROR', message, error_data))
    
    def debug(self, message: str, data: Optional[Dict] = None) -> None:
        """Log debug message (only when LOG_LEVEL=DEBUG)"""
        import os
        if os.environ.get('LOG_LEVEL') == 'DEBUG':
            print(self._format_message('DEBUG', message, data))
    
    def log_request(self, event: Dict[str, Any]) -> None:
        """Log handler entry point"""
        self.info('Handler invoked', {
            'queryStringParameters': event.get('queryStringParameters'),
            'pathParameters': event.get('pathParameters'),
            'hasBody': bool(event.get('body')),
            'bodyLength': len(event.get('body', '') or ''),
        })
    
    def log_response(self, status_code: int, body: Any = None) -> None:
        """Log handler response"""
        body_str = json.dumps(body) if body else ''
        self.info('Handler response', {
            'statusCode': status_code,
            'bodyLength': len(body_str),
        })


def create_logger(event: Dict[str, Any], context: Any = None) -> Logger:
    """Create and initialize a new logger for the request"""
    logger = Logger()
    logger.init(event, context)
    return logger


