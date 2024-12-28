#!/usr/bin/env node
import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import dotenv from 'dotenv';
import { createObjectCsvWriter } from 'csv-writer';
import AWS from 'aws-sdk';
import path from 'path';
import fs from 'fs';
import * as cheerio from 'cheerio';
import pRetry from 'p-retry';

dotenv.config();

const PUBMED_API_KEY = process.env.PUBMED_API_KEY;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_SESSION_TOKEN = process.env.AWS_SESSION_TOKEN;
const AWS_REGION = process.env.AWS_REGION;
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET;

// Configure AWS
AWS.config.update({
  accessKeyId: AWS_ACCESS_KEY_ID,
  secretAccessKey: AWS_SECRET_ACCESS_KEY,
  sessionToken: AWS_SESSION_TOKEN,
  region: AWS_REGION
});

const s3 = new AWS.S3();

// Healthcare topics to search for
const HEALTHCARE_TOPICS = [
  'Utilization Review healthcare',
  'Care Management healthcare',
  'Care Coordination healthcare',
  'Practice Management healthcare',
  'Telehealth healthcare',
  'Population Health Management',
  'Value Based Care',
  'Healthcare Quality Improvement',
  'Clinical Decision Support',
  'Patient Engagement healthcare',
  'Healthcare Analytics',
  'Remote Patient Monitoring',
  'Healthcare Interoperability',
  'Preventive Care Management',
  'Chronic Disease Management'
];

// Helper function to create a unique key for an article
function createArticleKey(article: PubMedArticle | Paper): string {
  if ('pmid' in article) {
    return `pubmed-${article.pmid}`;
  } else {
    return `semantic-${article.paperId}`;
  }
}

// Helper function to deduplicate articles
function deduplicateArticles(articles: (PubMedArticle | Paper)[]): (PubMedArticle | Paper)[] {
  const seen = new Set<string>();
  return articles.filter(article => {
    const key = createArticleKey(article);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

interface PubMedArticle {
  pmid: string;
  title: string;
  abstract: string;
  authors: string[];
  publicationDate: string;
  journal: string;
  doi?: string;
}

interface SearchParams {
  query: string;
  year?: string;
  fields?: string;
  publicationTypes?: string;
  fieldsOfStudy?: string;
  venue?: string;
  openAccessPdf?: boolean;
  minCitationCount?: number;
  offset?: number;
  limit?: number;
}

interface Paper {
  paperId: string;
  title: string;
  abstract?: string;
  year?: number;
  referenceCount?: number;
  citationCount?: number;
  influentialCitationCount?: number;
  isOpenAccess?: boolean;
  fieldsOfStudy?: string[];
  authors?: Array<{
    authorId: string;
    name: string;
  }>;
  url?: string;
  venue?: string;
  publicationVenue?: {
    id?: string;
    name?: string;
    type?: string;
    url?: string;
  };
  openAccessPdf?: {
    url: string;
    status: string;
  };
}

class ScholarlyAPI {
  private pubmedClient: AxiosInstance;
  private semanticScholarClient: AxiosInstance;
  private rateLimitDelay = 3000; // 3 seconds between requests

  constructor() {
    this.pubmedClient = axios.create({
      baseURL: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
      params: {
        api_key: PUBMED_API_KEY,
        db: 'pubmed',
        retmode: 'xml',
      },
    });

    this.semanticScholarClient = axios.create({
      baseURL: 'https://api.semanticscholar.org/graph/v1',
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 30000 // 30 second timeout
    });

    // Configure retry logic for both clients
    axiosRetry(this.pubmedClient, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
          error.response?.status === 429;
      }
    });

    axiosRetry(this.semanticScholarClient, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
          error.response?.status === 429;
      }
    });
  }

  private async retryableRequest<T>(operation: () => Promise<T>, context: string): Promise<T> {
    return pRetry(operation, {
      retries: 3,
      onFailedAttempt: error => {
        console.log(
          `${context}: Attempt ${error.attemptNumber} failed. ${error.retriesLeft} retries left.`
        );
        // Exponential backoff with jitter
        const delay = Math.min(1000 * Math.pow(2, error.attemptNumber - 1), 10000) 
          + Math.random() * 1000;
        return new Promise(resolve => setTimeout(resolve, delay));
      }
    });
  }

  async searchPapers(params: SearchParams): Promise<{
    total: number;
    offset: number;
    next?: number;
    data: Paper[];
  }> {
    return this.retryableRequest(async () => {
      const response = await this.semanticScholarClient.get('/paper/search', {
        params: {
          query: params.query,
          fields: 'title,abstract,year,authors,url,venue,openAccessPdf,doi,paperId,isOpenAccess,publicationVenue',
          publicationTypes: 'Review,JournalArticle',
          fieldsOfStudy: 'Medicine',
          minCitationCount: 1,
          offset: params.offset || 0,
          limit: Math.min(params.limit || 100, 999 - (params.offset || 0)),
          year: '2018-2023'
        },
      });

      return response.data;
    }, 'Semantic Scholar search');
  }

  async searchPubMed(query: string): Promise<PubMedArticle[]> {
    return this.retryableRequest(async () => {
      // First search for IDs
      const searchResponse = await this.pubmedClient.get('/esearch.fcgi', {
        params: {
          term: query,
          retmax: 500,
          sort: 'relevance',
          datetype: 'pdat',
          mindate: '2018',
          maxdate: '2023'
        }
      });

      const $ = cheerio.load(searchResponse.data, { xmlMode: true });
      const allIds = $('IdList Id').map((_, el) => $(el).text()).get();
      
      if (!allIds.length) return [];

      const articles: PubMedArticle[] = [];
      const batchSize = 20; // Smaller batch size to avoid URL length issues

      // Process IDs in batches
      for (let i = 0; i < allIds.length; i += batchSize) {
        const idBatch = allIds.slice(i, i + batchSize);
        
        // Add delay between batches to respect rate limits
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        try {
          // Fetch details for current batch
          const detailsResponse = await this.pubmedClient.get('/efetch.fcgi', {
            params: {
              id: idBatch.join(','),
              rettype: 'abstract'
            }
          });

          const $details = cheerio.load(detailsResponse.data, { xmlMode: true });

          $details('PubmedArticle').each((_, article) => {
            try {
              const $article = cheerio.load(article, { xmlMode: true });

              // Extract data with safe fallbacks
              const pmid = $article('PMID').first().text() || '';
              const title = $article('ArticleTitle').first().text() || '';
              const abstract = $article('Abstract AbstractText').map((_, el) => $(el).text()).get().join(' ') || '';
              
              // Parse authors with proper error handling
              const authors: string[] = [];
              $article('Author').each((_, author) => {
                const $author = cheerio.load(author, { xmlMode: true });
                const lastName = $author('LastName').first().text();
                const foreName = $article('ForeName').first().text();
                if (lastName || foreName) {
                  authors.push(`${lastName} ${foreName}`.trim());
                }
              });

              // Extract other metadata
              const journal = $article('Journal Title').first().text() || '';
              const year = $article('PubDate Year').first().text() || '';
              const month = $article('PubDate Month').first().text() || '';
              const day = $article('PubDate Day').first().text() || '';
              const publicationDate = [year, month, day].filter(Boolean).join(' ');

              // Find DOI in article IDs
              const doi = $article('ArticleId[IdType="doi"]').first().text() || undefined;

              if (pmid && title) { // Only add articles with at least an ID and title
                articles.push({
                  pmid,
                  title,
                  abstract,
                  authors,
                  publicationDate,
                  journal,
                  doi
                });
              }
            } catch (err) {
              console.error('Error parsing article:', err);
            }
          });
        } catch (err) {
          console.error(`Error fetching batch ${i}-${i + batchSize}:`, err);
        }
      }

      return articles;
    }, 'PubMed search');
  }

  private async saveToCsv(articles: (PubMedArticle | Paper)[], filename: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const csvWriter = createObjectCsvWriter({
        path: filename,
        header: [
          { id: 'id', title: 'ID' },
          { id: 'title', title: 'Title' },
          { id: 'abstract', title: 'Abstract' },
          { id: 'authors', title: 'Authors' },
          { id: 'date', title: 'Publication Date' },
          { id: 'journal', title: 'Journal' },
          { id: 'doi', title: 'DOI' },
          { id: 'source', title: 'Source' }
        ]
      });

      const records = articles.map(article => {
        if ('pmid' in article) {
          return {
            id: article.pmid,
            title: article.title,
            abstract: article.abstract,
            authors: article.authors.join('; '),
            date: article.publicationDate,
            journal: article.journal,
            doi: article.doi || '',
            source: 'PubMed'
          };
        } else {
          return {
            id: article.paperId,
            title: article.title,
            abstract: article.abstract || '',
            authors: article.authors?.map(a => a.name).join('; ') || '',
            date: article.year?.toString() || '',
            journal: article.venue || '',
            doi: '',
            source: 'Semantic Scholar'
          };
        }
      });

      csvWriter.writeRecords(records)
        .then(() => resolve(filename))
        .catch(reject);
    });
  }

  private async uploadToS3(filepath: string): Promise<string> {
    const fileStream = fs.createReadStream(filepath);
    const filename = path.basename(filepath);
    
    const uploadParams = {
      Bucket: AWS_S3_BUCKET!,
      Key: filename,
      Body: fileStream
    };

    try {
      const result = await s3.upload(uploadParams).promise();
      return result.Location;
    } finally {
      fileStream.destroy(); // Ensure file stream is closed
    }
  }

  async searchAllTopics(): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const results: { topic: string; articles: (PubMedArticle | Paper)[]; }[] = [];

    for (const topic of HEALTHCARE_TOPICS) {
      console.log(`Searching for topic: ${topic}`);
      
      try {
        // Search PubMed
        const pubmedArticles = await this.searchPubMed(topic);
        console.log(`Found ${pubmedArticles.length} PubMed articles for ${topic}`);

        // Search Semantic Scholar with pagination
        let allSemanticResults: Paper[] = [];
        let offset = 0;
        const limit = 100;
        let hasMore = true;

        while (hasMore) {
          try {
            // Calculate next offset and limit to ensure we stay under 999
            const nextOffset = offset + limit;
            if (nextOffset >= 899) {
              console.log('Reached Semantic Scholar API limit (offset + limit must be < 999)');
              hasMore = false;
              continue;
            }

            // Calculate remaining space, staying well under 999 to be safe
            const remainingSpace = 899 - offset;
            const nextLimit = Math.min(limit, remainingSpace);

            const semanticResults = await this.searchPapers({
              query: topic,
              offset,
              limit: nextLimit
            });

            // Get full text for each paper
            for (const paper of semanticResults.data) {
              if (paper.paperId) {
                try {
                  const details = await this.semanticScholarClient.get(`/paper/${paper.paperId}`, {
                    params: {
                      fields: 'title,abstract,year,authors,url,venue,openAccessPdf,doi,isOpenAccess,publicationVenue,references,citations,embedding'
                    }
                  });
                  
                  // Update paper with full details
                  Object.assign(paper, details.data);

                  // If open access PDF available, get full text
                  if (paper.openAccessPdf?.url) {
                    console.log(`Fetching full text for paper ${paper.paperId}`);
                    // Add delay to respect rate limits
                    await new Promise(resolve => setTimeout(resolve, 1000));
                  }
                } catch (error) {
                  console.error(`Error getting details for paper ${paper.paperId}:`, error);
                }
              }
            }

            if (!semanticResults.data || semanticResults.data.length === 0) {
              hasMore = false;
              continue;
            }

            allSemanticResults = [...allSemanticResults, ...semanticResults.data];
            console.log(`Found ${semanticResults.data.length} more Semantic Scholar papers for ${topic} (total: ${allSemanticResults.length})`);

            if (!semanticResults.next) {
              hasMore = false;
            } else {
              offset = semanticResults.next;
              // Add a delay between requests
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 400) {
              console.log('Reached Semantic Scholar API limit');
              hasMore = false;
            } else {
              console.error(`Error in Semantic Scholar search for ${topic}:`, error);
              hasMore = false;
            }
          }
        }

        // Deduplicate articles before adding to results
        const combinedArticles = [...pubmedArticles, ...allSemanticResults];
        const uniqueArticles = deduplicateArticles(combinedArticles);
        console.log(`Removed ${combinedArticles.length - uniqueArticles.length} duplicate articles`);
        
        results.push({
          topic,
          articles: uniqueArticles
        });
      } catch (error) {
        console.error(`Error searching for topic ${topic}:`, error);
      }
    }

    // Save all results to CSV
    for (const result of results) {
      const filename = `${result.topic.replace(/\s+/g, '_')}_${timestamp}.csv`;
      try {
        const filepath = await this.saveToCsv(result.articles, filename);
        const s3Url = await this.uploadToS3(filepath);
        console.log(`Results for ${result.topic} uploaded to: ${s3Url}`);
        
        // Clean up local file with a delay to ensure upload is complete
        setTimeout(() => {
          fs.unlink(filepath, (err) => {
            if (err) console.error(`Error deleting file ${filepath}:`, err);
          });
        }, 1000);
      } catch (error) {
        console.error(`Error processing results for ${result.topic}:`, error);
      }
    }
  }
}

// Execute the search
const api = new ScholarlyAPI();
api.searchAllTopics()
  .then(() => console.log('Search completed successfully'))
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
