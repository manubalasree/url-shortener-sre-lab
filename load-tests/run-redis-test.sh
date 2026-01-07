#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}================================${NC}"
echo -e "${BLUE}Redis Cache Performance Test${NC}"
echo -e "${BLUE}================================${NC}"
echo ""

# Check if k6 is installed
if ! command -v k6 &> /dev/null; then
    echo -e "${RED}❌ Error: k6 is not installed${NC}"
    echo -e "${YELLOW}Install with: brew install k6${NC}"
    exit 1
fi

# Set default values
BASE_URL="${BASE_URL:-http://192.168.2.242}"
KUBECONFIG="${KUBECONFIG:-~/.kube/config-k3s}"

# Get Shlink API key from Kubernetes if not provided
if [ -z "$SHLINK_API_KEY" ]; then
    echo -e "${YELLOW}📋 Retrieving Shlink API key from Kubernetes...${NC}"

    # Check if kubectl is configured
    if ! KUBECONFIG=$KUBECONFIG kubectl get namespace shlink &> /dev/null; then
        echo -e "${RED}❌ Error: Cannot access Kubernetes cluster${NC}"
        echo -e "${YELLOW}Make sure KUBECONFIG is set correctly${NC}"
        exit 1
    fi

    # Try to get API key from secret
    SHLINK_API_KEY=$(KUBECONFIG=$KUBECONFIG kubectl get secret -n shlink shlink-api-key -o jsonpath='{.data.api-key}' 2>/dev/null | base64 -d 2>/dev/null || echo "")

    if [ -z "$SHLINK_API_KEY" ]; then
        echo -e "${YELLOW}⚠️  API key secret not found. Trying to extract from deployment...${NC}"

        # Alternative: Create a test API key via the API
        echo -e "${YELLOW}You can manually set the API key with:${NC}"
        echo -e "${YELLOW}export SHLINK_API_KEY=your-api-key${NC}"
        echo ""
        echo -e "${RED}❌ Error: SHLINK_API_KEY is required${NC}"
        exit 1
    fi
fi

echo -e "${GREEN}✅ Configuration:${NC}"
echo -e "   Base URL: $BASE_URL"
echo -e "   API Key: ${SHLINK_API_KEY:0:10}...${SHLINK_API_KEY: -5}"
echo ""

# Create results directory if it doesn't exist
mkdir -p load-tests/results

# Check if Shlink is accessible
echo -e "${YELLOW}🔍 Checking Shlink health...${NC}"
HEALTH_CHECK=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/rest/health" || echo "000")

if [ "$HEALTH_CHECK" != "200" ]; then
    echo -e "${RED}❌ Error: Shlink is not accessible at $BASE_URL${NC}"
    echo -e "${YELLOW}HTTP Status: $HEALTH_CHECK${NC}"
    echo -e "${YELLOW}Check if the application is running:${NC}"
    echo -e "${YELLOW}  KUBECONFIG=$KUBECONFIG kubectl get pods -n shlink${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Shlink is healthy${NC}"
echo ""

# Optional: Check Redis status
echo -e "${YELLOW}🔍 Checking Redis status...${NC}"
REDIS_STATUS=$(KUBECONFIG=$KUBECONFIG kubectl exec -n redis rfr-shlink-redis-0 -- redis-cli ping 2>/dev/null || echo "ERROR")

if [ "$REDIS_STATUS" = "PONG" ]; then
    echo -e "${GREEN}✅ Redis is responding${NC}"

    # Get current cache keys
    CACHE_KEYS=$(KUBECONFIG=$KUBECONFIG kubectl exec -n redis rfr-shlink-redis-0 -- redis-cli DBSIZE 2>/dev/null | grep -oE '[0-9]+' || echo "0")
    echo -e "${GREEN}   Current cache keys: $CACHE_KEYS${NC}"
else
    echo -e "${YELLOW}⚠️  Warning: Could not check Redis status${NC}"
fi
echo ""

# Ask if user wants to clear Redis cache first
read -p "Clear Redis cache before test? (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}🗑️  Clearing Redis cache...${NC}"
    KUBECONFIG=$KUBECONFIG kubectl exec -n redis rfr-shlink-redis-0 -- redis-cli FLUSHALL > /dev/null 2>&1
    echo -e "${GREEN}✅ Cache cleared${NC}"
    echo ""
fi

# Run the test
echo -e "${BLUE}================================${NC}"
echo -e "${BLUE}🚀 Starting Load Test${NC}"
echo -e "${BLUE}================================${NC}"
echo ""

cd "$(dirname "$0")"

k6 run \
  --env BASE_URL="$BASE_URL" \
  --env SHLINK_API_KEY="$SHLINK_API_KEY" \
  redis-cache-performance.js

# Check if test completed successfully
if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}================================${NC}"
    echo -e "${GREEN}✅ Test completed successfully!${NC}"
    echo -e "${GREEN}================================${NC}"
    echo ""

    # Check if results were generated
    if [ -f "results/redis-cache-performance-summary.json" ]; then
        echo -e "${GREEN}📊 Results saved:${NC}"
        echo -e "   JSON: results/redis-cache-performance-summary.json"
    fi

    if [ -f "results/redis-cache-performance-report.html" ]; then
        echo -e "   HTML: results/redis-cache-performance-report.html"
        echo ""
        echo -e "${YELLOW}💡 Tip: Open the HTML report in your browser:${NC}"
        echo -e "${YELLOW}   open results/redis-cache-performance-report.html${NC}"
    fi

    echo ""
    echo -e "${YELLOW}📈 View metrics in real-time:${NC}"
    echo -e "   Grafana: http://192.168.2.242:3000"
    echo -e "   Kiali:   http://192.168.2.242:20001"
    echo -e "   Jaeger:  http://192.168.2.242:16686"

else
    echo ""
    echo -e "${RED}❌ Test failed${NC}"
    exit 1
fi
