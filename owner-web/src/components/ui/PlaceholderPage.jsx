// Used by every module page not yet built (Phase 8 per docs/ARCHITECTURE.md §Z)
// so navigation is fully wired without pretending a module is done.
export default function PlaceholderPage({ title }) {
  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
      <p className="mt-2 text-sm text-gray-500">
        Not built yet — this module lands in Phase 8 (Product Owner web dashboard) per docs/ARCHITECTURE.md §Z.
      </p>
    </div>
  )
}
