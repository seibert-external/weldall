import ReactMarkdown from "react-markdown";

export function SkillContent({ content }: { content: string }) {
  return (
    <div className="skill-markdown">
      <ReactMarkdown
        components={{
          img: ({ alt }) => (
            <span className="skill-markdown-image-note">[Image: {alt || "omitted"}]</span>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
