import { scrape } from '../src/index.js';

const urls = process.argv.slice(2);
if (!urls.length) {
  console.error('Uso: node examples/scrape.js https://example.com https://example.org');
  process.exitCode = 1;
} else {
  const results = await scrape(urls, {
    concurrency: 2,
    eval: '({ title: document.title, links: Array.from(document.querySelectorAll("a[href]"), a => ({ text: a.textContent.trim(), href: a.href })) })',
  });
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => !result.ok)) process.exitCode = 1;
}
