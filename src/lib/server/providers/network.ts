// Network providers: VPC networking, security groups, Cloud Map, Global Accelerator, Classic Load Balancers,
// Network Firewall, Route 53 Resolver and VPC Lattice — the network layer under the services on the map.
// Each lives in its own file (discovery, detail, IAM lists); see ./types.ts for the contract.
import "server-only";
import { cloudmapProvider } from "./cloudmap.ts";
import { elbClassicProvider } from "./elb-classic.ts";
import { globalacceleratorProvider } from "./globalaccelerator.ts";
import { networkFirewallProvider } from "./network-firewall.ts";
import { route53ResolverProvider } from "./route53-resolver.ts";
import { securityGroupProvider } from "./security-group.ts";
import { vpcProvider } from "./vpc.ts";
import { vpcLatticeProvider } from "./vpc-lattice.ts";
import type { Provider } from "./types.ts";

export const providers: Provider[] = [
  vpcProvider, securityGroupProvider, cloudmapProvider, globalacceleratorProvider, elbClassicProvider, networkFirewallProvider,
  route53ResolverProvider, vpcLatticeProvider,
];
