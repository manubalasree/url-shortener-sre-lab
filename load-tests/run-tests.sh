#!/usr/bin/env bash

# Load Testing Execution Script for Shlink URL Shortener
# This script runs all three k6 load test scenarios

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="${SCRIPT_DIR}/results"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Load .env file if it exists
if [ -f "${SCRIPT_DIR}/.env" ]; then
    # Export variables from .env file
    set -a
    source "${SCRIPT_DIR}/.env"
    set +a
fi

# Environment variables with defaults
BASE_URL="${BASE_URL:-http://192.168.2.242}"
SHLINK_API_KEY="${SHLINK_API_KEY:-}"

# Function to print colored messages
print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_header() {
    echo ""
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo ""
}

# Function to check prerequisites
check_prerequisites() {
    print_header "Checking Prerequisites"

    # Check if .env file exists
    if [ -f "${SCRIPT_DIR}/.env" ]; then
        print_success ".env file found and loaded"
    else
        print_warning ".env file not found"
        print_info "Create .env file from template:"
        print_info "  cp .env.example .env"
        print_info "  # Then edit .env and add your SHLINK_API_KEY"
    fi

    # Check if k6 is installed
    if ! command -v k6 &> /dev/null; then
        print_error "k6 is not installed"
        print_info "Install k6:"
        print_info "  macOS: brew install k6"
        print_info "  Linux: See https://k6.io/docs/getting-started/installation/"
        exit 1
    fi
    print_success "k6 is installed: $(k6 version)"

    # Check if BASE_URL is set
    if [ -z "$BASE_URL" ]; then
        print_error "BASE_URL is not set"
        print_info "Set BASE_URL in .env file or export it:"
        print_info "  export BASE_URL=http://192.168.2.242"
        exit 1
    fi
    print_success "BASE_URL: $BASE_URL"

    # Check if SHLINK_API_KEY is set
    if [ -z "$SHLINK_API_KEY" ]; then
        print_error "SHLINK_API_KEY is not set"
        print_info "Generate an API key and add it to .env file:"
        print_info "  kubectl exec -n shlink deployment/shlink -c shlink -- /etc/shlink/bin/cli api-key:generate"
        print_info "Then add the key to .env:"
        print_info "  SHLINK_API_KEY=your-generated-key"
        exit 1
    else
        print_success "SHLINK_API_KEY is set"
    fi

    # Create results directory
    mkdir -p "$RESULTS_DIR"
    print_success "Results directory: $RESULTS_DIR"
}

# Function to check system health before test
check_system_health() {
    print_header "Checking System Health"

    # Test if Shlink is accessible
    print_info "Testing Shlink health endpoint..."
    if curl -sf "${BASE_URL}/rest/health" > /dev/null; then
        print_success "Shlink is healthy and accessible"
    else
        print_error "Shlink health check failed"
        print_info "URL: ${BASE_URL}/rest/health"
        exit 1
    fi

    # Check if kubectl is available for monitoring
    if command -v kubectl &> /dev/null; then
        print_info "Checking Kubernetes pods..."
        kubectl get pods -n shlink 2>/dev/null || print_warning "Could not check Kubernetes pods"
    fi
}

# Function to run a test scenario
run_scenario() {
    local scenario_name=$1
    local script_file=$2
    local description=$3

    print_header "Running $scenario_name"
    print_info "$description"

    local result_file="${RESULTS_DIR}/${scenario_name}-${TIMESTAMP}.json"
    local summary_file="${RESULTS_DIR}/${scenario_name}-${TIMESTAMP}-summary.txt"

    print_info "Script: $script_file"
    print_info "Results: $result_file"
    print_info ""
    print_warning "Starting test in 5 seconds... (Ctrl+C to cancel)"
    sleep 5

    # Run k6 test
    if k6 run \
        --env BASE_URL="$BASE_URL" \
        --env SHLINK_API_KEY="$SHLINK_API_KEY" \
        --out json="$result_file" \
        --summary-export="$summary_file" \
        "$script_file"; then
        print_success "$scenario_name completed successfully"
        print_info "Results saved to: $result_file"
        print_info "Summary saved to: $summary_file"
        return 0
    else
        print_error "$scenario_name failed"
        return 1
    fi
}

# Function to display menu
show_menu() {
    echo ""
    echo "Load Testing Menu"
    echo "================="
    echo "1) Run Scenario 1: Baseline (Normal Day)"
    echo "2) Run Scenario 2: Peak Hours"
    echo "3) Run Scenario 3: Viral Event"
    echo "4) Run All Scenarios"
    echo "5) Check System Health"
    echo "6) View Results"
    echo "0) Exit"
    echo ""
}

# Function to view results
view_results() {
    print_header "Recent Test Results"

    if [ ! -d "$RESULTS_DIR" ] || [ -z "$(ls -A $RESULTS_DIR 2>/dev/null)" ]; then
        print_warning "No results found"
        return
    fi

    echo "Latest results:"
    ls -lht "$RESULTS_DIR" | head -20
    echo ""
    print_info "Results directory: $RESULTS_DIR"
}

# Main execution
main() {
    clear
    print_header "Shlink Load Testing Suite"

    check_prerequisites
    check_system_health

    # If arguments provided, run specific scenario
    if [ $# -gt 0 ]; then
        case $1 in
            scenario1|baseline)
                run_scenario "scenario1-baseline" \
                    "${SCRIPT_DIR}/scenario1-baseline.js" \
                    "Baseline test: 1 URL creation/sec, 20 redirects/sec, 10 minutes"
                ;;
            scenario2|peak)
                run_scenario "scenario2-peak-hours" \
                    "${SCRIPT_DIR}/scenario2-peak-hours.js" \
                    "Peak hours test: 2 URL creations/sec, 50 redirects/sec, 5 minutes"
                ;;
            scenario3|viral)
                run_scenario "scenario3-viral-event" \
                    "${SCRIPT_DIR}/scenario3-viral-event.js" \
                    "Viral event test: 5-8 URL creations/sec, 100-200 redirects/sec, 10 minutes"
                ;;
            all)
                run_scenario "scenario1-baseline" \
                    "${SCRIPT_DIR}/scenario1-baseline.js" \
                    "Baseline test: 1 URL creation/sec, 20 redirects/sec, 10 minutes"

                print_info "Waiting 2 minutes before next test..."
                sleep 120

                run_scenario "scenario2-peak-hours" \
                    "${SCRIPT_DIR}/scenario2-peak-hours.js" \
                    "Peak hours test: 2 URL creations/sec, 50 redirects/sec, 5 minutes"

                print_info "Waiting 2 minutes before next test..."
                sleep 120

                run_scenario "scenario3-viral-event" \
                    "${SCRIPT_DIR}/scenario3-viral-event.js" \
                    "Viral event test: 5-8 URL creations/sec, 100-200 redirects/sec, 10 minutes"
                ;;
            *)
                print_error "Unknown scenario: $1"
                print_info "Usage: $0 [scenario1|scenario2|scenario3|all]"
                exit 1
                ;;
        esac
        exit 0
    fi

    # Interactive menu
    while true; do
        show_menu
        read -p "Select option: " choice

        case $choice in
            1)
                run_scenario "scenario1-baseline" \
                    "${SCRIPT_DIR}/scenario1-baseline.js" \
                    "Baseline test: 1 URL creation/sec, 20 redirects/sec, 10 minutes"
                ;;
            2)
                run_scenario "scenario2-peak-hours" \
                    "${SCRIPT_DIR}/scenario2-peak-hours.js" \
                    "Peak hours test: 2 URL creations/sec, 50 redirects/sec, 5 minutes"
                ;;
            3)
                run_scenario "scenario3-viral-event" \
                    "${SCRIPT_DIR}/scenario3-viral-event.js" \
                    "Viral event test: 5-8 URL creations/sec, 100-200 redirects/sec, 10 minutes"
                ;;
            4)
                run_scenario "scenario1-baseline" \
                    "${SCRIPT_DIR}/scenario1-baseline.js" \
                    "Baseline test: 1 URL creation/sec, 20 redirects/sec, 10 minutes"

                print_info "Waiting 2 minutes before next test..."
                sleep 120

                run_scenario "scenario2-peak-hours" \
                    "${SCRIPT_DIR}/scenario2-peak-hours.js" \
                    "Peak hours test: 2 URL creations/sec, 50 redirects/sec, 5 minutes"

                print_info "Waiting 2 minutes before next test..."
                sleep 120

                run_scenario "scenario3-viral-event" \
                    "${SCRIPT_DIR}/scenario3-viral-event.js" \
                    "Viral event test: 5-8 URL creations/sec, 100-200 redirects/sec, 10 minutes"
                ;;
            5)
                check_system_health
                ;;
            6)
                view_results
                ;;
            0)
                print_info "Exiting..."
                exit 0
                ;;
            *)
                print_error "Invalid option"
                ;;
        esac

        echo ""
        read -p "Press Enter to continue..."
    done
}

# Run main function
main "$@"
