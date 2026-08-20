export function DirectoryHeader({
  children,
  logoUrl,
}: {
  children: React.ReactNode;
  logoUrl: string;
}) {
  return (
    <header className="directory-header">
      <a className="directory-brand" href="/" aria-label="Weldall home">
        <img src="/assets/images/weldall.png" alt="Weldall" width={182} height={51} />
        {logoUrl ? <span aria-hidden="true">×</span> : null}
        {logoUrl ? <img src={logoUrl} alt="" width={958} height={245} /> : null}
      </a>
      <div className="directory-header-actions">{children}</div>
    </header>
  );
}
