// The edge, storage and DNS providers: S3 buckets, CloudFront distributions, Route 53 zones and Cloudflare zones —
// the front door of the map (DNS → CDN → load balancers / APIs / buckets) and where static data lives.
import "server-only";
import { cloudflare } from "./cloudflare.ts";
import { cloudfront } from "./cloudfront.ts";
import { route53 } from "./route53.ts";
import { s3 } from "./s3.ts";
import type { Provider } from "./types.ts";

export const providers: Provider[] = [s3, cloudfront, route53, cloudflare];
