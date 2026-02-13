const url = process.argv[2] || 'http://localhost:3000/api/health';
async function main() {
  try {
    const res = await fetch(url);
    const text = await res.text();
    console.log(text);
  } catch (e) {
    console.error('Health check failed:', e.message);
    process.exit(1);
  }
}
main();
