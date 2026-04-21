ReceiptIQ: Developer-First Receipt OCR API 🧾➡️ {JSON}
Turn any receipt or invoice into structured JSON in under 2 seconds.

Built for developers who need high-accuracy OCR without the complexity of training models or managing templates.

Get Your API Key | Live Demo | Support

🚀 The Problem
Most OCR tools are either too slow, require rigid templates, or return "word soup" that developers then have to parse manually. ReceiptIQ solves this with a single POST request that returns clean, structured data ready for your database.

✨ Key Features
Zero Training: No need to teach the AI what a "Walmart" receipt looks like.

Lightning Fast: Sub-2 second response times.

Structured Output: Get back Merchant name, Date, Total, Tax, and Currency.

Credit-Based Pricing: Pay for what you use with tiers starting at $10.

Privacy First: Images are processed and never used for training third-party models.

🛠 Quick Start (Node.js)
Integrate ReceiptIQ into your application in minutes:
const fetch = require('node-fetch');
const fs = require('fs');

async function parseReceipt() {
  const image = fs.readFileSync('receipt.jpg', {encoding: 'base64'});

  const response = await fetch('https://api.receiptiq.dev/v1/scan', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer YOUR_API_KEY'
    },
    body: JSON.stringify({ image_base64: image })
  });

  const data = await response.json();
  console.log(data);
}

parseReceipt();
📊 Standard JSON Output
ReceiptIQ extracts the following fields by default:

merchant_name (e.g., "Starbucks")

transaction_date (ISO 8601 format)

total_amount (Float)

tax_amount (Float)

currency (e.g., "USD", "EUR")

line_items (Optional/Beta)

💰 Pricing Tiers
We offer simple, credit-based pricing for projects of all sizes:

Starter: $10 for 100 scans

Growth: $25 for 300 scans

Scale: $100 for 1,500 scans

🔗 Links
Website: https://receiptiq.dev
