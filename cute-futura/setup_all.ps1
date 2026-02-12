$env:Path = "C:\Program Files\nodejs;" + $env:Path
Write-Host "Installing dependencies..."
npm install
Write-Host "Setting up database..."
node scripts/setup_db.js
Write-Host "Running tests..."
node scripts/test_concurrency.js
