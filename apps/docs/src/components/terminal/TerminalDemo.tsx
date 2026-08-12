import { AnimatedSpan, Terminal, TypingAnimation } from "./Terminal";

const copy = {
  de: {
    employeeRequest: "> Zeig mir alle Mitarbeitenden meines Unternehmens",
    listsSkills: "Agent listet Skills auf",
    readsSkill: "Agent liest den Skill",
    requestsData: "Agent ruft Daten ab",
    employeesFound: "✔ 247 Mitarbeitende gefunden",
    employeeCounts: "218 aktiv · 24 inaktiv · 5 weitere",
    teamRequest: "> Liste alle Mitglieder des Jira-Teams auf",
    filtersData: "Agent filtert die Mitarbeiterdaten",
    teamMembers: "✔ Alex, Kim, Morgan, Sam und Taylor",
  },
  en: {
    employeeRequest: "> Show me all employees of my company",
    listsSkills: "Agent lists skills",
    readsSkill: "Agent reads skill",
    requestsData: "Agent requests data",
    employeesFound: "✔ 247 employees found",
    employeeCounts: "218 active · 24 inactive · 5 other",
    teamRequest: "> List everyone on the Jira team",
    filtersData: "Agent filters the employee data",
    teamMembers: "✔ Alex, Kim, Morgan, Sam and Taylor",
  },
} as const;

interface TerminalDemoProps {
  locale?: keyof typeof copy;
}

export const TerminalDemo = ({ locale = "en" }: TerminalDemoProps) => {
  const text = copy[locale];

  return (
    <Terminal>
      <TypingAnimation>{text.employeeRequest}</TypingAnimation>

      <AnimatedSpan className="magic-terminal__line--info">{text.listsSkills}</AnimatedSpan>
      <TypingAnimation>$ weldall skills</TypingAnimation>
      <AnimatedSpan className="magic-terminal__line--success">
        ✔ HR Server Read · hr-server.read
      </AnimatedSpan>

      <AnimatedSpan className="magic-terminal__line--info">{text.readsSkill}</AnimatedSpan>
      <TypingAnimation>$ weldall skills show hr-server.read</TypingAnimation>
      <AnimatedSpan className="magic-terminal__line--success">
        ✔ Scope hr-server:read · GET /company/employees
      </AnimatedSpan>

      <AnimatedSpan className="magic-terminal__line--info">{text.requestsData}</AnimatedSpan>
      <TypingAnimation>
        $ weldall request --scope hr-server:read …/company/employees
      </TypingAnimation>

      <AnimatedSpan className="magic-terminal__line--success">{text.employeesFound}</AnimatedSpan>
      <TypingAnimation className="magic-terminal__line--muted">
        {text.employeeCounts}
      </TypingAnimation>

      <TypingAnimation>{text.teamRequest}</TypingAnimation>
      <AnimatedSpan className="magic-terminal__line--info">{text.filtersData}</AnimatedSpan>
      <AnimatedSpan className="magic-terminal__line--success">{text.teamMembers}</AnimatedSpan>
    </Terminal>
  );
};
