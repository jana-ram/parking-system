import { NavLink, Outlet } from 'react-router-dom'
import { LogOut } from 'lucide-react'
import { NAV_ITEMS } from '../../config/navPermissions'
import { useAuthStore } from '../../context/authStore'

export default function AppShell() {
  const { admin, logout } = useAuthStore()

  return (
    <div className="flex h-screen bg-gray-50">
      <aside className="w-60 shrink-0 border-r border-gray-200 bg-white flex flex-col">
        <div className="px-4 py-4 font-semibold text-gray-900">Smart Parking OS</div>
        <nav className="flex-1 overflow-y-auto px-2 space-y-1">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.key}
              to={item.path}
              className={({ isActive }) =>
                `block rounded-md px-3 py-2 text-sm font-medium ${
                  isActive ? 'bg-gray-900 text-white' : 'text-gray-700 hover:bg-gray-100'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-gray-200 p-3 flex items-center justify-between text-sm text-gray-600">
          <span>{admin?.name || 'Platform Admin'}</span>
          <button onClick={logout} className="text-gray-400 hover:text-gray-700" title="Log out">
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto p-6">
        <Outlet />
      </main>
    </div>
  )
}
