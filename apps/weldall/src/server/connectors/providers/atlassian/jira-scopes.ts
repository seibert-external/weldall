/** Jira Cloud platform classic OAuth scopes. Granular scopes are not supported. */
export const JIRA_SCOPES_REFERENCE =
  "https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/";

/** Atlassian recommends classic scopes wherever available. */
export const JIRA_CLASSIC_SCOPES = [
  {
    id: "read:jira-user",
    label: "View user profiles",
    description:
      "View user information in Jira that the user has access to, including usernames, email addresses, and avatars.",
  },
  {
    id: "read:jira-work",
    label: "View Jira issue data",
    description:
      "Read Jira project and issue data, search for issues and objects associated with issues like attachments and worklogs.",
  },
  {
    id: "write:jira-work",
    label: "Create and manage issues",
    description:
      "Create and edit issues in Jira, post comments as the user, create worklogs, and delete issues.",
  },
  {
    id: "manage:jira-project",
    label: "Manage project settings",
    description:
      "Create and edit project settings and create new project-level objects (for example, versions and components).",
  },
  {
    id: "manage:jira-configuration",
    label: "Manage Jira global settings",
    description:
      "Take Jira administration actions (for example, create projects and custom fields, view workflows, and manage issue link types).",
  },
  {
    id: "manage:jira-webhook",
    label: "Manage Jira webhooks",
    description: "Fetch, register, refresh, and delete dynamically declared Jira webhooks.",
  },
] as const;

export type JiraScope = (typeof JIRA_CLASSIC_SCOPES)[number];
export type JiraScopeId = JiraScope["id"];
