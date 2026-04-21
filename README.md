ReceiptIQ: Developer-First Receipt OCR API 🧾➡️ {JSON}
Turn any receipt or invoice into structured JSON in under 5 seconds.

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

💻 Quick Start (JavaScript/cURL)
1. The Endpoint
POST [https://receiptiq.dev/api/parse](https://receiptiq.dev/api/parse)
const res = await fetch("https://receiptiq.dev/api/parse", {
  method: "POST",
  headers: {
    "x-api-key": "riq_live_your_key",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ 
    image: base64Data, 
    media_type: "image/jpeg" 
  })
});

const { data: receipt } = await res.json();
console.log(receipt.merchant.name); // "Blue Bottle Coffee"

parseReceipt();
📊 Standard JSON Output
ReceiptIQ extracts the following fields by default:
{
  "success": true,
  "data": {
    "merchant": { "name": "...", "address": "...", "phone": "..." },
    "transaction": { "date": "YYYY-MM-DD", "payment_method": "...", "receipt_number": "..." },
    "items": [{ "description": "...", "quantity": 1, "unit_price": 4.50, "total": 4.50 }],
    "totals": { "subtotal": 4.50, "tax": 0.38, "tip": null, "total": 4.88 },
    "currency": "USD",
    "category": "restaurant"
  },
  "meta": { "processing_time_ms": 1842, "credits_remaining": 499 }
}

💰 Pricing Tiers
We offer simple, credit-based pricing for projects of all sizes:

Starter: $10 for 100 scans

Growth: $25 for 300 scans

Scale: $100 for 1,500 scans

🔗 Links
Website: https://receiptiq.dev
