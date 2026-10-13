// Docs navigation. Each entry is docs/<slug>.md in the repo (also readable on GitHub).
export const DOCS: { section: string; pages: { slug: string; title: string }[] }[] = [
  { section: "Start", pages: [
    { slug: "index", title: "Overview" },
    { slug: "quickstart", title: "Quickstart" },
    { slug: "faq", title: "Common questions" },
  ] },
  { section: "Connect", pages: [
    { slug: "connect-aws", title: "Connect AWS" },
    { slug: "discovery", title: "How discovery works" },
    { slug: "configuration", title: "Configuration" },
    { slug: "github", title: "GitHub & CI" },
  ] },
  { section: "Cloud map", pages: [
    { slug: "cloud-map", title: "Cloud map" },
    { slug: "services", title: "Supported services" },
    { slug: "permissions", title: "Permissions setup" },
    { slug: "notes", title: "Notes" },
  ] },
  { section: "Operate", pages: [
    { slug: "dashboards", title: "Dashboards" },
    { slug: "auth", title: "Sign-in & roles" },
    { slug: "integrations", title: "Integrations" },
    { slug: "actions", title: "Actions & safety" },
    { slug: "environment-variables", title: "Environment variables" },
    { slug: "provisioning", title: "Create & scale" },
    { slug: "costs", title: "Costs & usage" },
  ] },
  { section: "Automate", pages: [
    { slug: "automation", title: "Agents & API" },
    { slug: "operations", title: "Operations reference" },
  ] },
  { section: "Run it", pages: [
    { slug: "deploy", title: "Deploy the console" },
    { slug: "security", title: "Security model" },
    { slug: "troubleshooting", title: "Troubleshooting" },
    { slug: "limitations", title: "Limitations & roadmap" },
  ] },
];

export const ALL_PAGES = DOCS.flatMap((s) => s.pages);
