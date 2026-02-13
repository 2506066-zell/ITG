const url = process.argv[2] || 'http://localhost:3000/';
async function main() {
  try {
    const res = await fetch(url);
    console.log('Status:', res.status);
  } catch (e) {
    console.error('Ping failed:', e.message);
    process.exit(1);
  }
}
main();
