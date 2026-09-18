import { useState } from 'react';
import type { ArtifactSummary } from '../shared/dashboard.js';
import { t as text } from './i18n.js';
import { enc } from './display.js';

export function ArtifactView({
  artifact,
  submission,
}: {
  artifact: ArtifactSummary;
  submission?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const src = `/artifacts/${enc(artifact.id)}/${artifact.version}${submission ? `?submission=${enc(submission)}` : ''}`;
  return (
    <section className={`artifact ${expanded ? 'artifact-expanded' : ''}`}>
      <div className="artifact-heading">
        <span>
          {text('HTML 展示 ·')} {artifact.title}
        </span>
        <button type="button" className="subtle" onClick={() => setExpanded(!expanded)}>
          {expanded ? text('收起展示') : text('扩大展示')}
        </button>
      </div>
      <iframe
        title={artifact.title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        src={src}
        loading="lazy"
      />
    </section>
  );
}
