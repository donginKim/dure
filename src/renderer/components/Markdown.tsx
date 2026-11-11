import { Fragment, memo } from 'react';
import { toBlocks, toInline } from '../chatView';

/** `코드` 와 **굵게** 를 글자로만 그린다. */
function InlineText({ text }: { text: string }) {
  return (
    <>
      {toInline(text).map((part, i) => {
        if (part.code) return <code key={i} className={part.bold ? 'bold' : undefined}>{part.text}</code>;
        return part.bold ? <strong key={i}>{part.text}</strong> : <Fragment key={i}>{part.text}</Fragment>;
      })}
    </>
  );
}

/**
 * 에이전트가 쓴 마크다운을 그린다. HTML 로 넣지 않고 React 요소로만 만든다:
 * 에이전트의 글에 든 태그나 스크립트는 글자 그대로 보인다. 링크는 누를 수 없는 글자다.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {toBlocks(text).map((b, i) => {
        switch (b.type) {
          case 'heading': return <div key={i} className={`md-h md-h${Math.min(b.level, 3)}`}><InlineText text={b.text} /></div>;
          case 'code': return <pre key={i} className="md-code">{b.lang && <span className="md-lang">{b.lang}</span>}<code>{b.text}</code></pre>;
          case 'rule': return <hr key={i} className="md-rule" />;
          case 'list': {
            const List = b.ordered ? 'ol' : 'ul';
            return <List key={i} className="md-list">{b.items.map((item, j) => <li key={j} style={item.depth ? { marginLeft: item.depth * 18 } : undefined}><InlineText text={item.text} /></li>)}</List>;
          }
          case 'table': return (
            <div key={i} className="md-table-wrap">
              <table className="md-table">
                <thead><tr>{b.rows[0]!.map((c, j) => <th key={j}><InlineText text={c} /></th>)}</tr></thead>
                <tbody>{b.rows.slice(1).map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><InlineText text={c} /></td>)}</tr>)}</tbody>
              </table>
            </div>
          );
          default: return <p key={i}><InlineText text={b.text} /></p>;
        }
      })}
    </div>
  );
});
