import { Component } from 'react';

/**
 * Catches Mapbox GL errors (invalid token, WebGL unavailable, etc.)
 * so they don't blank the entire coordinator page.
 */
export default class MapErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="w-full h-full flex flex-col items-center justify-center bg-gray-950 text-center px-8">
          <p className="text-red-400 font-semibold mb-2">Map failed to load</p>
          <p className="text-gray-500 text-sm max-w-sm">
            {String(this.state.error.message || this.state.error)}
          </p>
          {!import.meta.env.VITE_MAPBOX_TOKEN && (
            <p className="text-amber-400 text-xs mt-3">
              Add <code className="bg-gray-800 px-1 rounded">VITE_MAPBOX_TOKEN</code> to{' '}
              <code className="bg-gray-800 px-1 rounded">frontend/.env</code> and restart Vite.
            </p>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
