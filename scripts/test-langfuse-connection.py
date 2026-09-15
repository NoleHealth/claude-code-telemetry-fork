#!/usr/bin/env python3
"""
Test Langfuse Connection Script

This script tests the connection to Langfuse and creates a simple trace
to verify the telemetry bridge is working correctly.
"""

import sys
import subprocess
import time
from datetime import datetime

def install_packages():
    """Install required packages if not already installed"""
    # Only `requests` is needed - this script talks to Langfuse's ingestion API
    # directly over HTTP and never imports the `langfuse` Python SDK.
    packages = [
        ("requests", "requests")
    ]

    for package_name, import_name in packages:
        try:
            __import__(import_name)
            print(f"✅ {package_name} already installed")
        except ImportError:
            print(f"📦 Installing {package_name} package...")
            subprocess.check_call([sys.executable, "-m", "pip", "install", package_name])
            print(f"✅ {package_name} installed successfully")

def test_langfuse_connection():
    """Test connection to Langfuse using HTTP requests"""
    try:
        import requests
        import json
        import uuid
        
        print("🔌 Testing Langfuse connection...")
        
        # Test health endpoint first
        health_url = "http://localhost:3020/api/public/health"
        print(f"🔍 Checking health endpoint: {health_url}")
        
        health_response = requests.get(health_url, timeout=10)
        if health_response.status_code == 200:
            print("✅ Langfuse health check passed")
        else:
            print(f"⚠️ Health check returned status {health_response.status_code}")
        
        # Test ingestion endpoint
        ingestion_url = "http://localhost:3020/api/public/ingestion"
        print(f"🔄 Testing ingestion endpoint: {ingestion_url}")
        
        # Create test data
        trace_id = str(uuid.uuid4())
        generation_id = str(uuid.uuid4())
        timestamp = datetime.now().isoformat() + "Z"
        
        # Create payload
        payload = {
            "batch": [
                {
                    "id": trace_id,
                    "type": "trace-create",
                    "timestamp": timestamp,
                    "body": {
                        "id": trace_id,
                        "name": "telemetry-bridge-test",
                        "userId": "test-user",
                        "sessionId": f"test-session-{int(time.time())}",
                        "metadata": {
                            "test_type": "connection_verification",
                            "timestamp": timestamp,
                            "source": "telemetry-bridge-test-script"
                        }
                    }
                },
                {
                    "id": generation_id,
                    "type": "generation-create",
                    "timestamp": timestamp,
                    "body": {
                        "id": generation_id,
                        "traceId": trace_id,
                        "name": "test-generation",
                        "model": "test-model",
                        "input": "This is a test input for telemetry bridge verification",
                        "output": "This is a test output confirming the connection works",
                        "metadata": {
                            "test": True,
                            "purpose": "verify telemetry bridge connection"
                        },
                        "usage": {
                            "input": 10,
                            "output": 12,
                            "total": 22
                        }
                    }
                }
            ]
        }
        
        # Prepare headers with authentication (Basic auth with public:secret)
        import base64
        import os
        public_key = os.environ.get("LANGFUSE_PUBLIC_KEY")
        secret_key = os.environ.get("LANGFUSE_SECRET_KEY")
        if not public_key or not secret_key:
            print("❌ LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set in the environment")
            return False
        auth_string = f"{public_key}:{secret_key}"
        auth_bytes = auth_string.encode('ascii')
        auth_b64 = base64.b64encode(auth_bytes).decode('ascii')
        
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Basic {auth_b64}"
        }
        
        # Send ingestion request
        print("📤 Sending test trace to Langfuse...")
        response = requests.post(
            ingestion_url,
            headers=headers,
            data=json.dumps(payload),
            timeout=10
        )
        
        print(f"📊 Response status: {response.status_code}")
        if response.status_code in [200, 207]:
            print("✅ Test trace sent successfully to Langfuse!")
            print("\n🎉 Langfuse connection test completed!")
            print("📊 Check your Langfuse dashboard at http://localhost:3020")
            print("   Look for a trace named 'telemetry-bridge-test'")
            return True
        else:
            print(f"❌ Ingestion failed with status {response.status_code}")
            print(f"Response: {response.text}")
            return False
        
    except Exception as e:
        print(f"❌ Error testing Langfuse connection: {e}")
        import traceback
        traceback.print_exc()
        return False

def main():
    """Main test function"""
    print("🚀 Testing Langfuse Connection for Telemetry Bridge")
    print("=" * 50)
    
    # Install required packages if needed
    install_packages()
    
    # Test the connection
    success = test_langfuse_connection()
    
    if success:
        print("\n✅ All tests passed!")
        print("🔗 Your telemetry bridge should now be ready to receive Claude Code data")
        sys.exit(0)
    else:
        print("\n❌ Tests failed!")
        print("🔧 Check your Langfuse instance and configuration")
        sys.exit(1)

if __name__ == "__main__":
    main()