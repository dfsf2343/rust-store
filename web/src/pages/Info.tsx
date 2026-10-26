import { Link } from 'react-router';
import { PageHeader } from '../components/bits';
import { useStore } from '../data';

export function Rules() {
  const { site } = useStore();
  return (
    <div className="container page page--narrow">
      <PageHeader title="Rules">
        <p>Breaking these gets you warned, kicked or banned depending on how serious it is. Staff decisions are final.</p>
      </PageHeader>
      {site.rules.map((group) => (
        <section key={group.title} className="rules">
          <h2 className="subhead">{group.title}</h2>
          <ul className="rules__list">
            {group.items.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function Faq() {
  const { site } = useStore();
  return (
    <div className="container page page--narrow">
      <PageHeader title="Questions">
        <p>
          Something not covered here? Ask in{' '}
          {site.links.discord ? (
            <a href={site.links.discord} target="_blank" rel="noreferrer">
              our Discord
            </a>
          ) : (
            'our Discord'
          )}
          .
        </p>
      </PageHeader>
      <div className="faq">
        {site.faq.map((item) => (
          <details key={item.q} className="faq__item">
            <summary className="faq__q">{item.q}</summary>
            <p className="faq__a">{item.a}</p>
          </details>
        ))}
      </div>
      <p className="crumbs">
        <Link to="/refunds">Read the refund policy</Link>
      </p>
    </div>
  );
}
