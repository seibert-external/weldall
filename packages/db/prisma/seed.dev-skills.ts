import type { PrismaClient } from "@prisma/client";

type DevelopmentSkillEntry = {
  key: string;
  title: string;
  purpose: string;
  tags: string[];
};

type DevelopmentSkillDomain = {
  key: string;
  label: string;
  owner: string;
  involvedScopes: [string, string, string];
  skills: DevelopmentSkillEntry[];
};

const domains: DevelopmentSkillDomain[] = [
  {
    key: "finance",
    label: "Finance",
    owner: "dev-finance-owner",
    involvedScopes: ["expenses:read", "contracts:read", "projects:plan"],
    skills: [
      {
        key: "budget-variance",
        title: "Analyze budget variance",
        purpose: "compare actual spending with the approved budget and explain material deviations",
        tags: ["budgeting", "analysis"],
      },
      {
        key: "cash-flow-forecast",
        title: "Prepare a cash flow forecast",
        purpose: "project incoming and outgoing cash and identify likely liquidity gaps",
        tags: ["cash flow", "forecasting"],
      },
      {
        key: "expense-review",
        title: "Review employee expenses",
        purpose: "check expense submissions for completeness, policy fit, and unusual items",
        tags: ["expenses", "review"],
      },
      {
        key: "invoice-reconciliation",
        title: "Reconcile supplier invoices",
        purpose: "match invoices against purchase orders and receipts before payment",
        tags: ["invoices", "accounts payable"],
      },
      {
        key: "month-end-close",
        title: "Coordinate month-end close",
        purpose: "prepare a close checklist, track dependencies, and summarize unresolved entries",
        tags: ["accounting", "month end"],
      },
      {
        key: "revenue-summary",
        title: "Summarize revenue performance",
        purpose:
          "break down revenue by period, segment, and product and highlight important changes",
        tags: ["revenue", "reporting"],
      },
      {
        key: "cost-center-report",
        title: "Create a cost center report",
        purpose: "organize costs by cost center and surface missing or inconsistent allocations",
        tags: ["cost centers", "reporting"],
      },
      {
        key: "payment-run",
        title: "Prepare a payment run",
        purpose: "assemble due payments, flag exceptions, and produce an approval-ready summary",
        tags: ["payments", "accounts payable"],
      },
      {
        key: "financial-controls",
        title: "Assess financial controls",
        purpose:
          "review evidence for key financial controls and document gaps and follow-up actions",
        tags: ["controls", "audit"],
      },
      {
        key: "forecast-scenarios",
        title: "Compare forecast scenarios",
        purpose:
          "compare baseline, optimistic, and downside financial scenarios with clear assumptions",
        tags: ["forecasting", "scenarios"],
      },
    ],
  },
  {
    key: "human-resources",
    label: "Human Resources",
    owner: "dev-human-resources-owner",
    involvedScopes: ["people:manage", "knowledge:write", "contracts:read"],
    skills: [
      {
        key: "onboarding-plan",
        title: "Create an employee onboarding plan",
        purpose:
          "build a role-specific onboarding schedule with owners, milestones, and required access",
        tags: ["onboarding", "employees"],
      },
      {
        key: "offboarding-checklist",
        title: "Prepare an offboarding checklist",
        purpose: "coordinate access removal, equipment return, handover, and final documentation",
        tags: ["offboarding", "access"],
      },
      {
        key: "leave-request-review",
        title: "Review a leave request",
        purpose:
          "summarize a leave request, relevant balances, conflicts, and the required approval path",
        tags: ["leave", "approvals"],
      },
      {
        key: "job-description",
        title: "Draft a job description",
        purpose:
          "turn role requirements into a clear job description with responsibilities and qualifications",
        tags: ["recruiting", "roles"],
      },
      {
        key: "candidate-scorecard",
        title: "Create a candidate scorecard",
        purpose:
          "define consistent interview criteria and summarize evidence without making unsupported claims",
        tags: ["recruiting", "interviews"],
      },
      {
        key: "performance-review",
        title: "Prepare a performance review",
        purpose:
          "organize goals, feedback, outcomes, and development topics into a balanced review draft",
        tags: ["performance", "feedback"],
      },
      {
        key: "training-plan",
        title: "Build a training plan",
        purpose: "map skill gaps to practical learning activities, owners, and target dates",
        tags: ["learning", "development"],
      },
      {
        key: "policy-question",
        title: "Answer an HR policy question",
        purpose: "locate the relevant policy language and provide a concise answer with caveats",
        tags: ["policies", "employee support"],
      },
      {
        key: "headcount-report",
        title: "Summarize headcount changes",
        purpose:
          "report hires, departures, open roles, and organizational changes for a selected period",
        tags: ["headcount", "reporting"],
      },
      {
        key: "engagement-actions",
        title: "Plan employee engagement actions",
        purpose: "turn survey themes into prioritized actions with owners and measurable follow-up",
        tags: ["engagement", "planning"],
      },
    ],
  },
  {
    key: "contract-management",
    label: "Contract Management",
    owner: "dev-contract-management-owner",
    involvedScopes: ["contracts:approve", "crm:read", "licenses:read"],
    skills: [
      {
        key: "renewal-calendar",
        title: "Build a contract renewal calendar",
        purpose: "identify renewal and notice dates and organize them into an actionable calendar",
        tags: ["renewals", "deadlines"],
      },
      {
        key: "clause-comparison",
        title: "Compare contract clauses",
        purpose:
          "compare clause language across drafts and explain material commercial differences",
        tags: ["clauses", "comparison"],
      },
      {
        key: "obligation-register",
        title: "Create a contract obligation register",
        purpose: "extract obligations, owners, evidence, and due dates into a trackable register",
        tags: ["obligations", "tracking"],
      },
      {
        key: "contract-summary",
        title: "Summarize a contract",
        purpose:
          "summarize parties, term, value, responsibilities, termination rights, and notable risks",
        tags: ["summary", "review"],
      },
      {
        key: "approval-routing",
        title: "Route a contract for approval",
        purpose:
          "determine the required reviewers and prepare an approval package with open questions",
        tags: ["approvals", "workflow"],
      },
      {
        key: "supplier-agreement-review",
        title: "Review a supplier agreement",
        purpose:
          "identify operational, commercial, and compliance concerns in a supplier agreement",
        tags: ["suppliers", "risk"],
      },
      {
        key: "nda-intake",
        title: "Process an NDA request",
        purpose: "collect NDA intake details and identify deviations from the preferred template",
        tags: ["nda", "intake"],
      },
      {
        key: "contract-handover",
        title: "Prepare a contract handover",
        purpose: "translate signed terms into an operational handover for responsible teams",
        tags: ["handover", "operations"],
      },
      {
        key: "termination-assessment",
        title: "Assess contract termination options",
        purpose: "summarize termination rights, notice requirements, dependencies, and next steps",
        tags: ["termination", "assessment"],
      },
      {
        key: "contract-portfolio",
        title: "Report on the contract portfolio",
        purpose: "summarize contract volume, value, renewal exposure, and outstanding obligations",
        tags: ["portfolio", "reporting"],
      },
    ],
  },
  {
    key: "sales",
    label: "Sales",
    owner: "dev-sales-owner",
    involvedScopes: ["crm:write", "contracts:draft", "licenses:read"],
    skills: [
      {
        key: "account-brief",
        title: "Prepare an account brief",
        purpose:
          "compile account context, stakeholders, recent activity, opportunities, and open risks",
        tags: ["accounts", "briefing"],
      },
      {
        key: "opportunity-review",
        title: "Review a sales opportunity",
        purpose: "assess stage evidence, next steps, blockers, and forecast confidence",
        tags: ["pipeline", "opportunities"],
      },
      {
        key: "proposal-outline",
        title: "Create a proposal outline",
        purpose:
          "structure a customer proposal around needs, outcomes, scope, assumptions, and pricing inputs",
        tags: ["proposals", "customers"],
      },
      {
        key: "meeting-follow-up",
        title: "Draft a sales meeting follow-up",
        purpose:
          "summarize decisions, customer questions, commitments, and next steps after a meeting",
        tags: ["meetings", "follow-up"],
      },
      {
        key: "pipeline-summary",
        title: "Summarize the sales pipeline",
        purpose: "report pipeline coverage, stage movement, risk, and expected close timing",
        tags: ["pipeline", "reporting"],
      },
      {
        key: "renewal-risk",
        title: "Assess customer renewal risk",
        purpose:
          "combine usage, support, stakeholder, and commercial signals into a renewal risk assessment",
        tags: ["renewals", "risk"],
      },
      {
        key: "territory-plan",
        title: "Build a territory plan",
        purpose: "prioritize target accounts and define coverage, outreach, and measurable goals",
        tags: ["territories", "planning"],
      },
      {
        key: "pricing-request",
        title: "Prepare a pricing request",
        purpose: "collect deal context, requested terms, justification, and approval dependencies",
        tags: ["pricing", "approvals"],
      },
      {
        key: "win-loss-review",
        title: "Run a win-loss review",
        purpose: "summarize why an opportunity was won or lost and identify repeatable lessons",
        tags: ["analysis", "learning"],
      },
      {
        key: "forecast-call",
        title: "Prepare a forecast call",
        purpose:
          "organize commit, best-case, and pipeline deals with evidence and unresolved risks",
        tags: ["forecasting", "pipeline"],
      },
    ],
  },
  {
    key: "customer-support",
    label: "Customer Support",
    owner: "dev-customer-support-owner",
    involvedScopes: ["crm:read", "knowledge:write", "licenses:read"],
    skills: [
      {
        key: "ticket-triage",
        title: "Triage a support ticket",
        purpose:
          "classify impact and urgency, identify missing information, and recommend ownership",
        tags: ["tickets", "triage"],
      },
      {
        key: "incident-update",
        title: "Draft a customer incident update",
        purpose: "explain current impact, mitigation, known facts, and the next update time",
        tags: ["incidents", "communication"],
      },
      {
        key: "case-summary",
        title: "Summarize a customer case",
        purpose: "condense the issue history, troubleshooting, decisions, and current status",
        tags: ["cases", "summary"],
      },
      {
        key: "escalation-brief",
        title: "Prepare an escalation brief",
        purpose:
          "provide engineering or leadership with impact, evidence, attempts, and requested help",
        tags: ["escalations", "briefing"],
      },
      {
        key: "response-draft",
        title: "Draft a support response",
        purpose:
          "write a clear, empathetic response with verified steps and realistic expectations",
        tags: ["responses", "customers"],
      },
      {
        key: "knowledge-article",
        title: "Create a support knowledge article",
        purpose:
          "turn a resolved issue into reusable symptoms, causes, steps, and verification guidance",
        tags: ["knowledge base", "documentation"],
      },
      {
        key: "backlog-review",
        title: "Review the support backlog",
        purpose: "identify aging, blocked, high-impact, and misrouted cases that need action",
        tags: ["backlog", "operations"],
      },
      {
        key: "sla-risk",
        title: "Identify SLA risk",
        purpose:
          "find cases approaching service targets and recommend actions to protect commitments",
        tags: ["sla", "risk"],
      },
      {
        key: "customer-theme",
        title: "Analyze support themes",
        purpose: "group recent cases into product, documentation, process, and training themes",
        tags: ["analysis", "customer feedback"],
      },
      {
        key: "handover-note",
        title: "Prepare a support handover",
        purpose: "document active cases, customer commitments, risks, and immediate next actions",
        tags: ["handover", "continuity"],
      },
    ],
  },
  {
    key: "procurement",
    label: "Procurement",
    owner: "dev-procurement-owner",
    involvedScopes: ["contracts:approve", "expenses:approve", "licenses:manage"],
    skills: [
      {
        key: "purchase-request",
        title: "Prepare a purchase request",
        purpose: "capture business need, scope, budget, timing, and approval information",
        tags: ["purchasing", "requests"],
      },
      {
        key: "supplier-comparison",
        title: "Compare suppliers",
        purpose:
          "compare suppliers across requirements, pricing, risk, service, and implementation fit",
        tags: ["suppliers", "comparison"],
      },
      {
        key: "rfp-outline",
        title: "Create an RFP outline",
        purpose:
          "structure requirements, response instructions, evaluation criteria, and commercial questions",
        tags: ["rfp", "sourcing"],
      },
      {
        key: "bid-evaluation",
        title: "Evaluate supplier bids",
        purpose:
          "score bids consistently and document evidence, trade-offs, and clarification needs",
        tags: ["bids", "evaluation"],
      },
      {
        key: "supplier-onboarding",
        title: "Coordinate supplier onboarding",
        purpose: "track due diligence, master data, access, contracts, and operational readiness",
        tags: ["suppliers", "onboarding"],
      },
      {
        key: "spend-analysis",
        title: "Analyze procurement spend",
        purpose: "group spend by supplier and category and identify consolidation opportunities",
        tags: ["spend", "analysis"],
      },
      {
        key: "purchase-order-review",
        title: "Review a purchase order",
        purpose: "check quantities, pricing, terms, coding, approvals, and contract alignment",
        tags: ["purchase orders", "review"],
      },
      {
        key: "supplier-risk",
        title: "Assess supplier risk",
        purpose: "summarize operational, financial, security, concentration, and compliance risks",
        tags: ["suppliers", "risk"],
      },
      {
        key: "savings-tracker",
        title: "Maintain a savings tracker",
        purpose: "record sourcing initiatives, baselines, forecast savings, and realized outcomes",
        tags: ["savings", "tracking"],
      },
      {
        key: "renewal-negotiation",
        title: "Prepare a supplier renewal negotiation",
        purpose: "organize usage, benchmarks, alternatives, targets, and negotiation positions",
        tags: ["renewals", "negotiation"],
      },
    ],
  },
  {
    key: "legal-compliance",
    label: "Legal and Compliance",
    owner: "dev-legal-compliance-owner",
    involvedScopes: ["contracts:read", "knowledge:publish", "people:read"],
    skills: [
      {
        key: "policy-review",
        title: "Review a company policy",
        purpose: "check policy structure, ownership, controls, exceptions, and review cadence",
        tags: ["policies", "review"],
      },
      {
        key: "compliance-evidence",
        title: "Prepare compliance evidence",
        purpose: "map a control request to evidence, owners, periods, and unresolved gaps",
        tags: ["controls", "evidence"],
      },
      {
        key: "risk-register",
        title: "Update a risk register",
        purpose:
          "document risk statements, impact, likelihood, controls, owners, and treatment actions",
        tags: ["risk", "governance"],
      },
      {
        key: "data-request",
        title: "Coordinate a data subject request",
        purpose:
          "track identity checks, system searches, review steps, deadlines, and response status",
        tags: ["privacy", "data requests"],
      },
      {
        key: "regulatory-change",
        title: "Assess a regulatory change",
        purpose:
          "summarize a change, affected processes, implementation needs, and accountable owners",
        tags: ["regulation", "change"],
      },
      {
        key: "conflict-check",
        title: "Prepare a conflict check",
        purpose:
          "organize relevant parties and relationships for review without making a legal conclusion",
        tags: ["conflicts", "intake"],
      },
      {
        key: "control-gap",
        title: "Document a control gap",
        purpose:
          "describe the gap, affected requirement, exposure, interim measure, and remediation plan",
        tags: ["controls", "remediation"],
      },
      {
        key: "audit-response",
        title: "Draft an audit response",
        purpose: "respond to an audit finding with facts, root cause, actions, owners, and dates",
        tags: ["audit", "response"],
      },
      {
        key: "retention-check",
        title: "Review retention requirements",
        purpose: "identify applicable retention rules and flag conflicts or missing disposal steps",
        tags: ["retention", "records"],
      },
      {
        key: "compliance-report",
        title: "Prepare a compliance status report",
        purpose: "summarize control status, findings, overdue actions, and decisions needed",
        tags: ["compliance", "reporting"],
      },
    ],
  },
  {
    key: "operations",
    label: "Operations",
    owner: "dev-operations-owner",
    involvedScopes: ["projects:manage", "expenses:read", "licenses:manage"],
    skills: [
      {
        key: "process-map",
        title: "Create a process map",
        purpose: "document process steps, owners, inputs, outputs, decisions, and handoffs",
        tags: ["processes", "documentation"],
      },
      {
        key: "capacity-plan",
        title: "Build a capacity plan",
        purpose: "compare expected demand with available capacity and highlight constraints",
        tags: ["capacity", "planning"],
      },
      {
        key: "operating-review",
        title: "Prepare an operating review",
        purpose: "summarize performance, exceptions, root causes, actions, and decisions required",
        tags: ["performance", "review"],
      },
      {
        key: "handoff-design",
        title: "Improve a team handoff",
        purpose:
          "clarify entry criteria, ownership, required context, service levels, and escalation paths",
        tags: ["handoffs", "process improvement"],
      },
      {
        key: "incident-retrospective",
        title: "Run an incident retrospective",
        purpose:
          "build a factual timeline and identify contributing factors and corrective actions",
        tags: ["incidents", "retrospective"],
      },
      {
        key: "inventory-review",
        title: "Review inventory health",
        purpose: "identify shortages, excess stock, aging inventory, and replenishment risks",
        tags: ["inventory", "analysis"],
      },
      {
        key: "standard-operating-procedure",
        title: "Draft a standard operating procedure",
        purpose:
          "write repeatable steps with prerequisites, controls, exceptions, and verification",
        tags: ["sop", "documentation"],
      },
      {
        key: "kpi-definition",
        title: "Define an operational KPI",
        purpose: "specify purpose, formula, data source, owner, frequency, and interpretation",
        tags: ["kpi", "measurement"],
      },
      {
        key: "continuous-improvement",
        title: "Plan a process improvement",
        purpose:
          "frame the problem, baseline performance, proposed change, experiment, and measures",
        tags: ["improvement", "planning"],
      },
      {
        key: "weekly-operations",
        title: "Summarize weekly operations",
        purpose: "report throughput, quality, service levels, blockers, and next-week priorities",
        tags: ["weekly review", "reporting"],
      },
    ],
  },
  {
    key: "marketing",
    label: "Marketing",
    owner: "dev-marketing-owner",
    involvedScopes: ["crm:export", "knowledge:publish", "projects:plan"],
    skills: [
      {
        key: "campaign-brief",
        title: "Create a campaign brief",
        purpose:
          "define audience, objective, message, channels, deliverables, timing, and measures",
        tags: ["campaigns", "briefing"],
      },
      {
        key: "content-calendar",
        title: "Build a content calendar",
        purpose: "organize content themes, formats, owners, channels, and publication dates",
        tags: ["content", "planning"],
      },
      {
        key: "audience-profile",
        title: "Develop an audience profile",
        purpose:
          "summarize audience needs, context, objections, information sources, and useful messages",
        tags: ["audience", "research"],
      },
      {
        key: "launch-plan",
        title: "Prepare a product launch plan",
        purpose:
          "coordinate positioning, assets, channels, enablement, milestones, and launch measures",
        tags: ["launch", "planning"],
      },
      {
        key: "content-review",
        title: "Review marketing content",
        purpose:
          "check clarity, evidence, audience fit, consistency, calls to action, and required approvals",
        tags: ["content", "review"],
      },
      {
        key: "campaign-report",
        title: "Summarize campaign performance",
        purpose: "compare campaign results with goals and explain channel and audience differences",
        tags: ["campaigns", "reporting"],
      },
      {
        key: "seo-outline",
        title: "Create an SEO content outline",
        purpose:
          "structure a useful page around search intent, questions, evidence, and internal links",
        tags: ["seo", "content"],
      },
      {
        key: "event-plan",
        title: "Plan a customer event",
        purpose:
          "coordinate audience, agenda, speakers, promotion, logistics, follow-up, and success measures",
        tags: ["events", "customers"],
      },
      {
        key: "case-study",
        title: "Draft a customer case study",
        purpose:
          "organize verified customer context, challenge, approach, outcome, and approved quotations",
        tags: ["case studies", "customers"],
      },
      {
        key: "brand-check",
        title: "Run a brand consistency check",
        purpose:
          "review terminology, voice, visual references, claims, and calls to action for consistency",
        tags: ["brand", "quality"],
      },
    ],
  },
  {
    key: "engineering-it",
    label: "Engineering and IT",
    owner: "dev-engineering-it-owner",
    involvedScopes: ["projects:manage", "licenses:audit", "knowledge:write"],
    skills: [
      {
        key: "change-plan",
        title: "Prepare a production change plan",
        purpose:
          "document scope, dependencies, validation, rollout, communication, and rollback steps",
        tags: ["change management", "production"],
      },
      {
        key: "incident-triage",
        title: "Triage a technical incident",
        purpose:
          "summarize impact, evidence, timeline, hypotheses, ownership, and immediate actions",
        tags: ["incidents", "triage"],
      },
      {
        key: "service-review",
        title: "Review service health",
        purpose:
          "summarize availability, latency, errors, capacity, incidents, and improvement work",
        tags: ["services", "reliability"],
      },
      {
        key: "access-review",
        title: "Conduct an access review",
        purpose:
          "organize accounts, roles, owners, usage evidence, exceptions, and removal decisions",
        tags: ["access", "security"],
      },
      {
        key: "architecture-decision",
        title: "Draft an architecture decision record",
        purpose: "capture context, options, decision, consequences, and follow-up work",
        tags: ["architecture", "decisions"],
      },
      {
        key: "release-notes",
        title: "Prepare release notes",
        purpose:
          "summarize customer-visible changes, fixes, migrations, limitations, and rollout status",
        tags: ["releases", "communication"],
      },
      {
        key: "technical-debt",
        title: "Prioritize technical debt",
        purpose: "compare debt items by impact, risk, effort, dependencies, and opportunity cost",
        tags: ["technical debt", "prioritization"],
      },
      {
        key: "security-finding",
        title: "Assess a security finding",
        purpose:
          "document evidence, exposure, affected assets, severity inputs, and remediation options",
        tags: ["security", "risk"],
      },
      {
        key: "vendor-integration",
        title: "Plan a vendor integration",
        purpose:
          "define interfaces, authentication, data flow, failure modes, ownership, and rollout",
        tags: ["integrations", "vendors"],
      },
      {
        key: "runbook",
        title: "Create an operational runbook",
        purpose:
          "write diagnostics, safe actions, escalation criteria, rollback guidance, and verification",
        tags: ["runbooks", "operations"],
      },
    ],
  },
];

export const DEVELOPMENT_SKILL_COUNT = domains.reduce(
  (count, domain) => count + domain.skills.length,
  0,
);

export const DEVELOPMENT_SKILL_SCOPE_KEYS = [
  ...new Set(domains.flatMap((domain) => domain.involvedScopes)),
];

export const DEVELOPMENT_SKILL_RESOURCE_COUNTS = domains.flatMap((domain, domainIndex) =>
  domain.skills.map((_, skillIndex) => (domainIndex + skillIndex) % 4),
);

export async function seedDevelopmentSkills(db: PrismaClient, actor: string): Promise<void> {
  if (DEVELOPMENT_SKILL_COUNT !== 100) {
    throw new Error(`Expected 100 development skills, found ${DEVELOPMENT_SKILL_COUNT}.`);
  }
  if (![0, 1, 2, 3].every((count) => DEVELOPMENT_SKILL_RESOURCE_COUNTS.includes(count))) {
    throw new Error("Development skills must cover zero through three involved resources.");
  }

  const slugs = domains.flatMap((domain) =>
    domain.skills.map((skill) => `demo.${domain.key}.${skill.key}`),
  );
  await db.skill.deleteMany({
    where: {
      createdBy: actor,
      slug: { startsWith: "demo.", notIn: slugs },
    },
  });

  for (const [domainIndex, domain] of domains.entries()) {
    for (const [skillIndex, skill] of domain.skills.entries()) {
      const slug = `demo.${domain.key}.${skill.key}`;
      const content = [
        `# ${skill.title}`,
        "",
        `Use this skill to ${skill.purpose}.`,
        "",
        "## Expected result",
        "",
        "Return a concise result, identify missing information, and list the next actions with clear owners.",
      ].join("\n");
      const meta = {
        tags: [...new Set([domain.label.toLowerCase(), domain.key, ...skill.tags])],
        owner: domain.owner,
      };
      const lastUpdatedAt = `2026-06-${String(domainIndex + 1).padStart(2, "0")}`;
      const involvedResourceCount = (domainIndex + skillIndex) % 4;
      const requiredScopes = domain.involvedScopes.slice(0, involvedResourceCount);

      await db.skill.upsert({
        where: { slug },
        create: {
          id: `skill-${slug.replaceAll(".", "-")}`,
          slug,
          title: skill.title,
          content,
          requiredScopes,
          visibility: "DEFAULT",
          meta,
          lastUpdatedAt,
          createdBy: actor,
          updatedBy: actor,
        },
        update: {
          title: skill.title,
          content,
          requiredScopes,
          visibility: "DEFAULT",
          meta,
          lastUpdatedAt,
          updatedBy: actor,
        },
      });
    }
  }
}
