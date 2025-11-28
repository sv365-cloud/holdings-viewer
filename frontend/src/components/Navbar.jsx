export default function Navbar() {
  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-20">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-16">
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold tracking-tight text-gray-900">
            Holdings<span className="text-blue-600">Viewer</span>
            </span>
          </div>
        </div>
      </div>
    </nav>
  );
}
