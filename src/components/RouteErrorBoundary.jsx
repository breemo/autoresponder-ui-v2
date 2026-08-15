import React from "react";

// Minimal, scoped safety net — NOT a substitute for fixing the underlying
// cause of any specific crash. This app has no error boundary anywhere
// (verified: no componentDidCatch/getDerivedStateFromError exists in this
// codebase), so a single uncaught render exception in a route's content
// unmounts the ENTIRE React tree, including the sidebar/header rendered
// above it by SharedDashboardLayout — exactly the "blank page, no sidebar,
// no header, only page background" symptom this wraps. This has already
// happened once in this app for an unrelated reason (a missing import
// threw at render time with nothing to catch it).
//
// Scoped to route content only — placed inside SharedDashboardLayout
// around {children}, not around the whole app — so sidebar/header always
// survive a page-level crash instead of disappearing with it. The actual
// error is shown on screen and logged to the console, not hidden; this
// does not silence, swallow, or work around any bug, it only prevents one
// page's exception from taking down chrome that has nothing to do with it.
export default class RouteErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Route render error:", error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-3xl border border-red-200 bg-red-50 p-6 text-right" dir="rtl">
          <p className="text-sm font-bold text-red-700">حدث خطأ أثناء عرض هذه الصفحة.</p>
          <p className="mt-2 break-words text-xs text-red-600" dir="ltr">
            {String(this.state.error?.message || this.state.error)}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-4 rounded-xl border border-red-200 bg-white px-4 py-2 text-xs font-bold text-red-700 hover:bg-red-100"
          >
            إعادة المحاولة
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
