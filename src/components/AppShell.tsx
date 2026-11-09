'use client';

import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Bell,
  BookOpen,
  Briefcase,
  Building2,
  CalendarClock,
  CheckSquare,
  FileText,
  Home,
  Moon,
  PhoneIncoming,
  Plus,
  PoundSterling,
  ShieldAlert,
  SlidersHorizontal,
  Sun,
  UserPlus,
  Users,
} from 'lucide-react';
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
  switchUserAction,
  switchViewingRoleAction,
} from '@/app/actions';
import type { AttentionItem } from '@/domain/attention';
import { formatDateTime } from '@/domain/dates';
import {
  canPreviewAnyHomeRole,
  resolveHeaderDisplayedViewingRole,
  resolveViewingRoleOptions,
  type LeftRailVisibility,
} from '@/domain/homeConfig';
import { initials, personDisplayName } from '@/domain/names';
import type { SearchDoc } from '@/domain/search';
import { countMyUrgentBadgeTasks } from '@/domain/tasks';
import type { HomePagesConfig, NotificationItem, Person, Task } from '@/domain/types';
import type { EntraSessionPayload } from '@/server/entraAuth';
import { CompactHeaderSearch, StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface ViewingAsRoleSelectProps {
  activeViewingRole: string;
  currentUserRoles: string[];
  configuredRoleKeys: string[];
  pathname: string;
  roleMap: Map<string, string>;
  onChangeRole: (
    nextRole: string,
    selectEl: HTMLSelectElement,
    previousRole: string,
  ) => void;
}

function ViewingAsRoleSelectInner({
  activeViewingRole,
  currentUserRoles,
  configuredRoleKeys,
  pathname,
  roleMap,
  onChangeRole,
}: ViewingAsRoleSelectProps) {
  const searchParams = useSearchParams();
  const displayedViewingRole = resolveHeaderDisplayedViewingRole({
    activeViewingRole,
    pathname,
    previewRoleParam: searchParams.get('previewRole'),
    viewParam: searchParams.get('view'),
    configuredRoleKeys,
  });
  const roleOptions = resolveViewingRoleOptions({
    currentUserRoles,
    configuredRoleKeys,
    pathname,
    displayedRoleKey: displayedViewingRole,
  });

  return (
    <select
      id="viewing-as-role-select"
      name="viewingAsRole"
      aria-label="Viewing as role"
      value={displayedViewingRole}
      onChange={(e) => onChangeRole(e.target.value, e.currentTarget, displayedViewingRole)}
      style={{
        border: 0,
        background: 'transparent',
        color: 'var(--text-primary)',
        fontFamily: 'inherit',
        fontSize: 13,
        fontWeight: 700,
        cursor: 'pointer',
        paddingRight: 4,
      }}
    >
      {roleOptions.map((rk) => (
        <option key={rk} value={rk}>
          {rk === 'risk_compliance' ? 'Risk / Compliance' : (roleMap.get(rk) ?? rk)}
        </option>
      ))}
    </select>
  );
}

interface AppShellProps {
  currentUser: Person;
  effectiveWorkPerson: Person;
  currentUserRoles: string[];
  activeViewingRole: string;
  leftRailVisibility: LeftRailVisibility;
  homePagesConfig: HomePagesConfig;
  employees: Person[];
  searchIndex: SearchDoc[];
  attention: AttentionItem[];
  tasks: Task[];
  notifications: NotificationItem[];
  firmName?: string;
  entraSession?: Pick<
    EntraSessionPayload,
    'email' | 'displayName' | 'oid' | 'mfaVerified'
  > | null;
  children: React.ReactNode;
}

export function AppShell({
  currentUser,
  effectiveWorkPerson,
  currentUserRoles,
  activeViewingRole,
  leftRailVisibility,
  homePagesConfig,
  employees,
  searchIndex,
  attention,
  tasks,
  notifications,
  firmName = 'Firm',
  entraSession = null,
  children,
}: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { showToast } = useToast();

  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('onesquared_theme');
      if (saved === 'dark' || saved === 'light') {
        return saved;
      }
    }
    return 'light';
  });

  const newRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const avatarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  function toggleTheme() {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem('onesquared_theme', next);
  }

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (newRef.current && !newRef.current.contains(t)) setNewMenuOpen(false);
      if (notifRef.current && !notifRef.current.contains(t)) setNotifOpen(false);
      if (avatarRef.current && !avatarRef.current.contains(t)) setAvatarOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const userName = personDisplayName(currentUser);
  const userInitials = initials(userName);
  const effectiveName = personDisplayName(effectiveWorkPerson);

  const urgentTaskBadgeCount = useMemo(
    () => countMyUrgentBadgeTasks(tasks, effectiveWorkPerson.id),
    [tasks, effectiveWorkPerson.id],
  );
  const unreadNotifCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications],
  );

  const roleMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of homePagesConfig.roles) {
      m.set(r.key, r.label);
    }
    return m;
  }, [homePagesConfig.roles]);

  const demoMode = Boolean(homePagesConfig.firmSettings?.demoMode);
  const demoEmployees = useMemo(() => employees.filter((e) => e.demo), [employees]);
  const canPreviewAny = useMemo(
    () => canPreviewAnyHomeRole(currentUserRoles),
    [currentUserRoles],
  );
  const configuredRoleKeys = useMemo(
    () => homePagesConfig.roles.map((r) => r.key),
    [homePagesConfig.roles],
  );
  const fallbackRoleOptions = useMemo(
    () =>
      resolveViewingRoleOptions({
        currentUserRoles: canPreviewAny ? configuredRoleKeys : currentUserRoles,
        configuredRoleKeys,
        pathname,
        displayedRoleKey: activeViewingRole,
      }),
    [canPreviewAny, configuredRoleKeys, currentUserRoles, pathname, activeViewingRole],
  );

  const navItems = useMemo(() => {
    const items: {
      key: string;
      href: string;
      label: string;
      icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
      match: (p: string) => boolean;
      visible: boolean;
    }[] = [
      {
        key: 'home',
        href: '/',
        label: 'Home',
        icon: Home,
        match: (p) => p === '/',
        visible: leftRailVisibility.home,
      },
      {
        key: 'enquiries',
        href: '/enquiries',
        label: 'Enquiries & Quotes',
        icon: PhoneIncoming,
        match: (p) => p.startsWith('/enquiries') || p.startsWith('/quotes'),
        visible: leftRailVisibility.enquiries,
      },
      {
        key: 'tasks',
        href: '/tasks',
        label: 'Tasks',
        icon: CheckSquare,
        match: (p) => p.startsWith('/tasks'),
        visible: leftRailVisibility.tasks,
      },
      {
        key: 'keyDates',
        href: '/key-dates',
        label: 'Key dates',
        icon: CalendarClock,
        match: (p) => p.startsWith('/key-dates'),
        visible: leftRailVisibility.keyDates,
      },
      {
        key: 'matters',
        href: '/matters',
        label: 'Matters',
        icon: Briefcase,
        match: (p) => p.startsWith('/matters'),
        visible: leftRailVisibility.matters,
      },
      {
        key: 'people',
        href: '/people',
        label: 'People',
        icon: Users,
        match: (p) => p.startsWith('/people'),
        visible: leftRailVisibility.contacts,
      },
      {
        key: 'organisations',
        href: '/organisations',
        label: 'Organisations',
        icon: Building2,
        match: (p) => p.startsWith('/organisations'),
        visible: leftRailVisibility.contacts,
      },
      {
        key: 'finance',
        href: '/?view=finance',
        label: 'Finance',
        icon: PoundSterling,
        match: () => false,
        visible: leftRailVisibility.finance,
      },
      {
        key: 'risk',
        href: '/?view=risk_compliance',
        label: 'Risk and compliance',
        icon: ShieldAlert,
        match: () => false,
        visible: leftRailVisibility.risk,
      },
      {
        key: 'admin',
        href: '/admin/lists',
        label: 'Admin',
        icon: SlidersHorizontal,
        match: (p) => p.startsWith('/admin'),
        visible: leftRailVisibility.admin,
      },
      {
        key: 'docs',
        href: '/docs',
        label: 'Help & documentation',
        icon: BookOpen,
        match: (p) => p.startsWith('/docs'),
        visible: true,
      },
    ];
    return items.filter((i) => i.visible);
  }, [leftRailVisibility]);

  const attentionHref = (item: AttentionItem) => {
    if (item.recordType === 'person') return `/people/${item.recordId}`;
    if (item.recordType === 'organisation') return `/organisations/${item.recordId}`;
    if (item.recordType === 'enquiry') return `/enquiries/${item.recordId}`;
    if (item.recordType === 'task') return `/tasks/${item.recordId}`;
    return `/matters/${item.recordId}`;
  };

  async function handleRoleChange(
    nextRole: string,
    selectEl: HTMLSelectElement,
    previousRole: string,
  ) {
    const res = await switchViewingRoleAction(nextRole);
    if (!res.ok) {
      selectEl.value = previousRole;
      showToast(res.error ?? 'Role is not assigned to the current user.');
      return;
    }
    if (pathname === '/' && typeof window !== 'undefined' && window.location.search) {
      router.replace('/');
    }
    router.refresh();
  }

  return (
    <div className="app-shell">
      <aside className="left-rail" aria-label="Primary navigation">
        <Link href="/" className="logo-mark" aria-label="1Squared Home" title="1Squared Home">
          <span className="logo-mark__tile">1</span>
          <span className="logo-mark__sq" aria-hidden="true" />
        </Link>

        <nav className="rail-nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = item.match(pathname);
            const showTaskBadge = item.key === 'tasks' && urgentTaskBadgeCount > 0;
            return (
              <Link
                key={item.key}
                href={item.href}
                aria-label={
                  showTaskBadge
                    ? `${item.label} (${urgentTaskBadgeCount} due today or overdue)`
                    : item.label
                }
                aria-current={active ? 'page' : undefined}
                data-tooltip={
                  showTaskBadge ? `${item.label} (${urgentTaskBadgeCount})` : item.label
                }
                className={`rail-item ${active ? 'rail-item--active' : ''}`}
                style={{ position: 'relative' }}
              >
                <Icon size={21} strokeWidth={1.9} aria-hidden="true" />
                {showTaskBadge ? (
                  <span
                    aria-hidden="true"
                    style={{
                      position: 'absolute',
                      top: 4,
                      right: 4,
                      minWidth: 16,
                      height: 16,
                      padding: '0 4px',
                      borderRadius: 999,
                      background: 'var(--warning)',
                      color: '#fff',
                      fontSize: 10,
                      fontWeight: 700,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      lineHeight: 1,
                    }}
                  >
                    {urgentTaskBadgeCount}
                  </span>
                ) : null}
                <span className="rail-tooltip" role="tooltip">
                  {showTaskBadge ? `${item.label} (${urgentTaskBadgeCount})` : item.label}
                </span>
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="main-area">
        <header className="top-bar">
          <div className="top-bar__left" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {pathname !== '/' ? <CompactHeaderSearch searchIndex={searchIndex} /> : null}
          </div>

          <div className="top-bar__right">
            {entraSession ? (
              <Link
                href="/admin/rbac-and-entra"
                title={`Signed in via Microsoft Entra ID as ${entraSession.email || entraSession.displayName} (oid: ${entraSession.oid})`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 10px',
                  borderRadius: 6,
                  background: 'rgba(13, 92, 99, 0.1)',
                  border: '1px solid rgba(13, 92, 99, 0.3)',
                  color: 'var(--brand-teal, #0D5C63)',
                  fontSize: 12,
                  fontWeight: 700,
                  textDecoration: 'none',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: '#16a34a',
                  }}
                />
                <span>
                  Entra ID{entraSession.mfaVerified ? ' · MFA' : ''}
                </span>
              </Link>
            ) : (
              <a
                href={`/api/auth/login?returnTo=${encodeURIComponent(pathname || '/')}`}
                className="btn btn--ghost btn--sm"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '5px 10px',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <span>Sign in with Microsoft</span>
              </a>
            )}

            <label
              className="role-switcher"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 10px',
                borderRadius: 6,
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border-subtle)',
                fontSize: 12,
                color: 'var(--text-secondary)',
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--color-text-muted)',
                  fontWeight: 700,
                }}
              >
                Viewing as
              </span>
              <Suspense
                fallback={
                  <select
                    id="viewing-as-role-select"
                    name="viewingAsRole"
                    aria-label="Viewing as role"
                    value={activeViewingRole}
                    onChange={(e) =>
                      handleRoleChange(e.target.value, e.currentTarget, activeViewingRole)
                    }
                    style={{
                      border: 0,
                      background: 'transparent',
                      color: 'var(--text-primary)',
                      fontFamily: 'inherit',
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: 'pointer',
                      paddingRight: 4,
                    }}
                  >
                    {fallbackRoleOptions.map((rk) => (
                      <option key={rk} value={rk}>
                        {rk === 'risk_compliance'
                          ? 'Risk / Compliance'
                          : (roleMap.get(rk) ?? rk)}
                      </option>
                    ))}
                  </select>
                }
              >
                <ViewingAsRoleSelectInner
                  activeViewingRole={activeViewingRole}
                  currentUserRoles={currentUserRoles}
                  configuredRoleKeys={configuredRoleKeys}
                  pathname={pathname}
                  roleMap={roleMap}
                  onChangeRole={handleRoleChange}
                />
              </Suspense>
            </label>

            {activeViewingRole === 'enquiries_coordinator' || activeViewingRole === 'finance' ? null : activeViewingRole === 'risk_compliance' ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  const el = document.querySelector<HTMLInputElement>(
                    'header input[type="search"], .hero-search-input, header input',
                  );
                  if (el) {
                    el.focus();
                  } else {
                    router.push('/enquiries/new');
                  }
                }}
              >
                <Plus size={16} strokeWidth={2.4} aria-hidden="true" />
                <span>Run conflict search</span>
              </button>
            ) : (
              <div className="popover-anchor" ref={newRef}>
                <button
                  type="button"
                  className="btn btn--primary"
                  aria-haspopup="menu"
                  aria-expanded={newMenuOpen}
                  onClick={() => setNewMenuOpen((o) => !o)}
                >
                  <Plus size={16} strokeWidth={2.4} aria-hidden="true" />
                  <span>New</span>
                </button>
                {newMenuOpen ? (
                  <div className="popover-menu" role="menu" aria-label="Create new record">
                    <Link
                      href="/enquiries/new"
                      role="menuitem"
                      className="popover-menu__item"
                      onClick={() => setNewMenuOpen(false)}
                    >
                      <PhoneIncoming size={16} aria-hidden="true" />
                      <span>New enquiry</span>
                    </Link>
                    <Link
                      href="/quotes/new"
                      role="menuitem"
                      className="popover-menu__item"
                      onClick={() => setNewMenuOpen(false)}
                    >
                      <FileText size={16} aria-hidden="true" />
                      <span>New quote</span>
                    </Link>
                    <Link
                      href="/tasks/new"
                      role="menuitem"
                      className="popover-menu__item"
                      onClick={() => setNewMenuOpen(false)}
                    >
                      <CheckSquare size={16} aria-hidden="true" />
                      <span>New task</span>
                    </Link>
                    <Link
                      href="/matters/new"
                      role="menuitem"
                      className="popover-menu__item"
                      onClick={() => setNewMenuOpen(false)}
                    >
                      <Briefcase size={16} aria-hidden="true" />
                      <span>New matter</span>
                    </Link>
                    <Link
                      href="/people/new"
                      role="menuitem"
                      className="popover-menu__item"
                      onClick={() => setNewMenuOpen(false)}
                    >
                      <UserPlus size={16} aria-hidden="true" />
                      <span>New person</span>
                    </Link>
                    <Link
                      href="/organisations/new"
                      role="menuitem"
                      className="popover-menu__item"
                      onClick={() => setNewMenuOpen(false)}
                    >
                      <Building2 size={16} aria-hidden="true" />
                      <span>New organisation</span>
                    </Link>
                  </div>
                ) : null}
              </div>
            )}

            <div className="popover-anchor" ref={notifRef}>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Notifications (${unreadNotifCount} unread, ${attention.length} needing attention)`}
                aria-expanded={notifOpen}
                onClick={() => setNotifOpen((o) => !o)}
              >
                <Bell size={19} strokeWidth={1.9} aria-hidden="true" />
                {unreadNotifCount > 0 || attention.length > 0 ? (
                  <span className="notif-dot" aria-hidden="true" />
                ) : null}
              </button>
              {notifOpen ? (
                <div
                  className="popover-menu popover-menu--wide"
                  role="dialog"
                  aria-label="Notifications and alerts"
                  style={{ maxHeight: 460, overflowY: 'auto' }}
                >
                  <div
                    className="popover-menu__header"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span className="section-label">
                      Notifications ({unreadNotifCount} unread)
                    </span>
                    {unreadNotifCount > 0 ? (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        style={{ fontSize: 11, padding: '2px 6px' }}
                        onClick={async () => {
                          await markAllNotificationsReadAction();
                          router.refresh();
                        }}
                      >
                        Mark all read
                      </button>
                    ) : null}
                  </div>
                  <div className="popover-menu__list">
                    {notifications.length === 0 ? (
                      <div className="muted" style={{ padding: '8px 14px', fontSize: 13 }}>
                        No notifications yet.
                      </div>
                    ) : (
                      notifications.slice(0, 6).map((n) => (
                        <Link
                          key={n.id}
                          href={n.href}
                          className="popover-menu__row"
                          style={
                            !n.read ? { background: 'var(--bg-subtle)' } : undefined
                          }
                          onClick={async () => {
                            setNotifOpen(false);
                            if (!n.read) {
                              await markNotificationReadAction(n.id);
                            }
                          }}
                        >
                          <div>
                            <div className="popover-menu__title">
                              {!n.read ? '● ' : ''}
                              {n.title}
                            </div>
                            <div className="popover-menu__sub">
                              {n.detail} · {formatDateTime(n.createdAt)}
                            </div>
                          </div>
                        </Link>
                      ))
                    )}
                  </div>

                  {attention.length > 0 ? (
                    <>
                      <div className="popover-menu__divider" />
                      <div className="popover-menu__header">
                        <span className="section-label">
                          Needs attention ({attention.length})
                        </span>
                      </div>
                      <div className="popover-menu__list">
                        {attention.slice(0, 5).map((item, idx) => (
                          <Link
                            key={`${item.recordId}-${item.kind}-${idx}`}
                            href={attentionHref(item)}
                            className="popover-menu__row"
                            onClick={() => setNotifOpen(false)}
                          >
                            <div>
                              <div className="popover-menu__title">{item.title}</div>
                              <div className="popover-menu__sub">{item.detail}</div>
                            </div>
                            <StatusPill label={item.label} tone={item.tone} />
                          </Link>
                        ))}
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="popover-anchor" ref={avatarRef}>
              <button
                type="button"
                className="avatar-btn"
                aria-label={`Account menu (${userName}, ${userInitials})`}
                aria-expanded={avatarOpen}
                onClick={() => setAvatarOpen((o) => !o)}
              >
                {userInitials}
              </button>
              {avatarOpen ? (
                <div
                  className="popover-menu popover-menu--wide"
                  role="menu"
                  style={{ maxHeight: 540, overflowY: 'auto' }}
                >
                  <div className="popover-menu__header">
                    <div className="popover-menu__title">{userName}</div>
                    <div className="popover-menu__sub">
                      {currentUser.jobTitle || firmName}
                    </div>
                  </div>
                  <Link
                    href={`/people/${currentUser.id}`}
                    className="popover-menu__item"
                    onClick={() => setAvatarOpen(false)}
                  >
                    <span>View my employee profile</span>
                  </Link>
                  <button type="button" className="popover-menu__item" onClick={toggleTheme}>
                    {theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}
                    <span>Switch to {theme === 'light' ? 'dark' : 'light'} mode</span>
                  </button>
                  {entraSession ? (
                    <form action="/api/auth/logout" method="POST" style={{ margin: 0 }}>
                      <button
                        type="submit"
                        className="popover-menu__item"
                        style={{ width: '100%', textAlign: 'left' }}
                        onClick={() => setAvatarOpen(false)}
                      >
                        <span>Sign out of Microsoft Entra ({entraSession.email || entraSession.displayName})</span>
                      </button>
                    </form>
                  ) : (
                    <a
                      href={`/api/auth/login?returnTo=${encodeURIComponent(pathname || '/')}`}
                      className="popover-menu__item"
                      onClick={() => setAvatarOpen(false)}
                    >
                      <span>Sign in with Microsoft Entra ID</span>
                    </a>
                  )}

                  {demoMode && demoEmployees.length > 0 ? (
                    <>
                      <div className="popover-menu__divider" />
                      <div className="popover-menu__header">
                        <span className="section-label">Switch to demo user</span>
                      </div>
                      <div className="popover-menu__list">
                        {demoEmployees.map((emp) => {
                          const name = personDisplayName(emp);
                          const isCurrent = emp.id === currentUser.id;
                          const primaryRole = emp.roles?.[0] ?? 'fee_earner';
                          const roleLabel = roleMap.get(primaryRole) ?? emp.jobTitle;
                          return (
                            <button
                              key={emp.id}
                              type="button"
                              className={`popover-menu__item ${isCurrent ? 'popover-menu__item--active' : ''}`}
                              onClick={async () => {
                                try {
                                  const res = await switchUserAction(emp.id);
                                  if (!res.ok) {
                                    showToast('Could not switch demo persona.');
                                    return;
                                  }
                                  setAvatarOpen(false);
                                  router.refresh();
                                } catch (err) {
                                  showToast(
                                    err instanceof Error
                                      ? err.message
                                      : 'Could not switch demo persona.',
                                  );
                                }
                              }}
                            >
                              <span>{name}</span>
                              <span
                                className="muted"
                                style={{ fontSize: '0.78rem', marginLeft: 'auto' }}
                              >
                                {roleLabel.split('/')[0].trim()}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </header>

        {demoMode && currentUser.demo && currentUser.showsWorkOfId ? (
          <div
            role="status"
            data-testid="demo-user-banner"
            style={{
              padding: '6px 24px',
              background: 'var(--accent-soft, #E6F2F4)',
              borderBottom: '1px solid var(--border-subtle)',
              color: 'var(--brand-teal, #0D5C63)',
              fontSize: 12.5,
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <span>
              Demo user: showing <strong>{effectiveName}’s</strong> work ({userName})
            </span>
            <Link
              href="/admin/lists?section=homePages"
              style={{ fontSize: 12, color: 'inherit', textDecoration: 'underline' }}
            >
              Configure in Admin › Home pages
            </Link>
          </div>
        ) : null}

        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}
