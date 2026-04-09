#!/bin/bash
# build-plugin.sh - Package the PWA MiniClient as a SageTV plugin zip
#
# Creates a zip file suitable for SageTV plugin installation.
# Files are installed under SageTV/pwa-miniclient/ (via ResourcePath).
#
# Usage: ./build-plugin.sh [version]
#   version: optional, defaults to version in package.json

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Get version from argument or package.json
VERSION="${1:-$(node -e "console.log(require('./package.json').version)")}"
ZIP_NAME="pwa-miniclient-${VERSION}.zip"
BUILD_DIR="build/pwa-miniclient"

echo "=== Building PWA MiniClient plugin v${VERSION} ==="

# Clean
rm -rf build/
mkdir -p "$BUILD_DIR"

# Copy bridge
cp bridge/ws-bridge.js "$BUILD_DIR/"

# Copy public directory (the PWA)
cp -r public/ "$BUILD_DIR/public/"

# Copy package files for npm install on target
cp package.json "$BUILD_DIR/"
cp package-lock.json "$BUILD_DIR/" 2>/dev/null || true

# Create a startup script
cat > "$BUILD_DIR/start.sh" << 'STARTUP'
#!/bin/bash
# Start the PWA MiniClient bridge
# Run this from the pwa-miniclient directory
cd "$(dirname "$0")"

if ! command -v node &>/dev/null; then
    echo "ERROR: Node.js 18+ is required but not found."
    echo "Install from: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "ERROR: Node.js 18+ required, found v$(node --version)"
    exit 1
fi

if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install --production
fi

echo "Starting PWA MiniClient bridge on port 8099..."
exec node ws-bridge.js --serve-static "$@"
STARTUP
chmod +x "$BUILD_DIR/start.sh"

# Create the zip (paths relative to build/ so zip extracts as pwa-miniclient/)
cd build/
zip -r "../$ZIP_NAME" pwa-miniclient/
cd ..

# Generate MD5
if command -v md5sum &>/dev/null; then
    MD5=$(md5sum "$ZIP_NAME" | awk '{print $1}')
elif command -v md5 &>/dev/null; then
    MD5=$(md5 -q "$ZIP_NAME")
else
    MD5="(install md5sum to auto-generate)"
fi

echo ""
echo "=== Build complete ==="
echo "  File: $ZIP_NAME"
echo "  Size: $(du -h "$ZIP_NAME" | cut -f1)"
echo "  MD5:  $MD5"
echo ""
echo "Next steps:"
echo "  1. Create a GitHub Release tagged v${VERSION}"
echo "  2. Upload ${ZIP_NAME} to the release"
echo "  3. Update plugin/pwa-miniclient.xml:"
echo "     - Set <Version> to ${VERSION}"
echo "     - Set <MD5> to ${MD5}"
echo "     - Set <Location> to the release download URL"
echo "  4. Submit pwa-miniclient.xml to sagetv-plugin-repo via PR"

# Clean up build dir
rm -rf build/
