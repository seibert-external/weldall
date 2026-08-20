export function DirectoryHeader({
  children,
  logoUrl,
}: {
  children: React.ReactNode;
  logoUrl: string;
}) {
  return (
    <header className="directory-header">
      {logoUrl ? (
        <a className="directory-brand" href="/" aria-label="Skill directory home">
          <img src={logoUrl} alt="Company logo" width={958} height={245} />
        </a>
      ) : null}
      <div className="directory-header-actions">{children}</div>
    </header>
  );
}
