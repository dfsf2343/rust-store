import { Link } from 'react-router';

export function NotFound() {
  return (
    <div className="container page page--narrow">
      <div className="detour">
        <p className="detour__sign" aria-hidden="true">
          Road closed
        </p>
        <h1 className="detour__title">This page does not exist</h1>
        <p>The link may be old or mistyped.</p>
        <p>
          <Link className="button button--go" to="/">
            Back to the home page
          </Link>
        </p>
      </div>
    </div>
  );
}
