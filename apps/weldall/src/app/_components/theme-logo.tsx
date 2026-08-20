interface ThemeLogoProps {
  alt: string;
  className?: string;
  darkUrl: string;
  height: number;
  lightUrl: string;
  width: number;
}

export function ThemeLogo({ alt, className, darkUrl, height, lightUrl, width }: ThemeLogoProps) {
  if (!lightUrl) return null;
  if (lightUrl === darkUrl)
    return <img src={lightUrl} alt={alt} width={width} height={height} className={className} />;

  const classes = className ? `${className} ` : "";
  return (
    <>
      <img
        src={lightUrl}
        alt={alt}
        width={width}
        height={height}
        className={`${classes}theme-logo-light`}
      />
      <img
        src={darkUrl}
        alt={alt}
        width={width}
        height={height}
        className={`${classes}theme-logo-dark`}
      />
    </>
  );
}
