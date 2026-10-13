// Simulated Transfer Family of the Acme account (names from ../mock-names.ts), as ListServers + DescribeServer + ListUsers
// return it, per region. us-east-1: acme-partner-sftp, a public SFTP server with service-managed users and a custom
// hostname, where two partners drop files into the production uploads bucket (which triggers the thumbnailer). Other
// regions: none. Read-only.
import type { RawTransferServer } from "../../../inventory/app-platforms.ts";
import { REGION, TRANSFER } from "../mock-names.ts";

export function simTransfer(region: string): RawTransferServer[] {
  if (region !== REGION) return [];
  const s = TRANSFER.sftp;
  return [
    {
      Arn: s.arn, ServerId: s.id, State: "ONLINE", Domain: "S3", EndpointType: "PUBLIC", IdentityProviderType: "SERVICE_MANAGED", UserCount: 2,
      Protocols: ["SFTP"], SecurityPolicyName: "TransferSecurityPolicy-2024-01",
      Tags: [{ Key: "Name", Value: s.name }, { Key: "Environment", Value: "production" }, { Key: "transfer:customHostname", Value: "sftp.acme.example" }],
      described: true,
      users: [
        { UserName: "partner-logistics", HomeDirectory: `/${s.bucket}/partners/logistics`, HomeDirectoryType: "PATH", SshPublicKeyCount: 1 },
        { UserName: "partner-photos", HomeDirectory: `/${s.bucket}/partners/photos`, HomeDirectoryType: "PATH", SshPublicKeyCount: 2 },
      ],
      enrichment: { describe: "ok", users: "ok" },
    },
  ];
}
