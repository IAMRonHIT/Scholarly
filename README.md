# Scholarly

A comprehensive healthcare research data collection and analysis tool that aggregates academic papers from multiple sources including PubMed and Semantic Scholar.

## Features

- Multi-source paper collection from:
  - PubMed
  - Semantic Scholar
- Focused on healthcare topics including:
  - Utilization Review
  - Care Management
  - Care Coordination
  - Practice Management
  - Telehealth
  - Population Health Management
  - Value Based Care
  - Healthcare Quality Improvement
  - Clinical Decision Support
  - Patient Engagement
  - Healthcare Analytics
  - Remote Patient Monitoring
  - Healthcare Interoperability
  - Preventive Care Management
  - Chronic Disease Management
- Automatic deduplication of papers across sources
- CSV export functionality
- S3 storage integration
- Rate limiting and retry mechanisms

## Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file with the following variables:
   ```
   PUBMED_API_KEY=your_pubmed_api_key
   AWS_ACCESS_KEY_ID=your_aws_access_key
   AWS_SECRET_ACCESS_KEY=your_aws_secret_key
   AWS_SESSION_TOKEN=your_aws_session_token
   AWS_REGION=your_aws_region
   AWS_S3_BUCKET=your_s3_bucket
   ```

## Usage

Run the main data collection script:
```bash
npm run build
node build/index.js
```

Clear S3 bucket:
```bash
node build/clear-s3.js
```

## Development

Built with:
- TypeScript
- Node.js
- AWS SDK
- Axios
- Cheerio

## License

MIT
