import type { NextConfig } from "next";

// Content-Security-Policy: everything comes from this origin (fonts are self-hosted by next/font). Inline scripts stay
// allowed because Next's hydration and the pre-paint theme script are inline and the docs pages are static (no
// per-request nonce); what the policy still stops is loading from or sending to another origin, framing, <base>
// hijacking and form posts elsewhere. Development also needs eval for React's error overlay.
const dev = process.env.NODE_ENV !== "production";
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
// HSTS (F65): only when people reach the console over HTTPS (a public URL that says so, or a production build behind
// a TLS-terminating load balancer). Never on plain-HTTP local dev, where it would pin localhost to HTTPS.
const https = (process.env.CONSOLE_PUBLIC_URL ?? "").startsWith("https://") || process.env.NODE_ENV === "production";

const config: NextConfig = {
  output: "standalone",
  // A second dev server (e.g. one against a real AWS account beside the demo) needs its own build dir.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  reactStrictMode: true,
  agentRules: false, // don't let `next dev` write AGENTS.md / CLAUDE.md into the repo
  experimental: {
    // F64: the proxy buffers request bodies up to this size before the routes see them; past it the body is cut off
    // silently (Next's default is 10 MB). The largest body a route accepts is an 8 MB S3 upload, base64-encoded in
    // JSON (~10.7 MB), so 13 MB leaves headroom; the routes still check sizes themselves and answer 413.
    proxyClientMaxBodySize: "13mb",
  },
  // AWS SDK clients stay as runtime requires instead of being bundled into every route (names only — no globs).
  serverExternalPackages: [
    "@aws-sdk/client-ecs", "@aws-sdk/client-ecr", "@aws-sdk/client-cloudwatch-logs", "@aws-sdk/client-cloudwatch",
    "@aws-sdk/client-ec2", "@aws-sdk/client-rds", "@aws-sdk/client-elasticache", "@aws-sdk/client-elastic-load-balancing-v2",
    "@aws-sdk/client-ssm", "@aws-sdk/client-secrets-manager", "@aws-sdk/client-s3", "@aws-sdk/client-cost-explorer",
    "@aws-sdk/client-lambda", "@aws-sdk/client-sqs", "@aws-sdk/client-sns", "@aws-sdk/client-eventbridge", "@aws-sdk/client-sfn",
    "@aws-sdk/client-kinesis", "@aws-sdk/client-dynamodb", "@aws-sdk/client-api-gateway", "@aws-sdk/client-apigatewayv2",
    "@aws-sdk/client-cloudfront", "@aws-sdk/client-route-53", "@aws-sdk/client-eks", "@aws-sdk/client-apprunner",
    "@aws-sdk/client-elastic-beanstalk", "@aws-sdk/client-auto-scaling", "@aws-sdk/client-sts", "@aws-sdk/credential-provider-node",
    // the cloud map's coverage providers, the catch-all and Application Auto Scaling (wave A install)
    "@aws-sdk/client-servicediscovery", "@aws-sdk/client-iam", "@aws-sdk/client-kms", "@aws-sdk/client-acm",
    "@aws-sdk/client-efs", "@aws-sdk/client-opensearch", "@aws-sdk/client-kafka", "@aws-sdk/client-firehose",
    "@aws-sdk/client-scheduler", "@aws-sdk/client-codepipeline", "@aws-sdk/client-codebuild",
    "@aws-sdk/client-codedeploy", "@aws-sdk/client-cloudformation", "@aws-sdk/client-wafv2",
    "@aws-sdk/client-cognito-identity-provider", "@aws-sdk/client-backup", "@aws-sdk/client-sesv2",
    "@aws-sdk/client-synthetics", "@aws-sdk/client-memorydb", "@aws-sdk/client-redshift",
    "@aws-sdk/client-redshift-serverless", "@aws-sdk/client-mq", "@aws-sdk/client-pipes", "@aws-sdk/client-batch",
    "@aws-sdk/client-glue", "@aws-sdk/client-athena", "@aws-sdk/client-global-accelerator",
    "@aws-sdk/client-elastic-load-balancing", "@aws-sdk/client-transfer", "@aws-sdk/client-appsync",
    "@aws-sdk/client-amplify", "@aws-sdk/client-lightsail", "@aws-sdk/client-cloudtrail",
    "@aws-sdk/client-resource-explorer-2", "@aws-sdk/client-resource-groups-tagging-api",
    "@aws-sdk/client-config-service", "@aws-sdk/client-cloudcontrol", "@aws-sdk/client-application-auto-scaling",
    "@aws-sdk/client-sagemaker", "@aws-sdk/client-bedrock", "@aws-sdk/client-bedrock-agent",
    "@aws-sdk/client-bedrock-runtime", "@aws-sdk/client-fsx", "@aws-sdk/client-network-firewall",
    "@aws-sdk/client-route53resolver", "@aws-sdk/client-vpc-lattice",
  ],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: CSP },
          ...(https ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
        ],
      },
    ];
  },
};

export default config;
