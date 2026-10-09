// Métricas exibidas sem inferir conclusão, presença de perfil ou sucesso.
export function formatRate(numerator: number, denominator: number): string {
  if (!Number.isFinite(denominator) || denominator <= 0) return 'Sem dados'
  if (!Number.isFinite(numerator) || numerator < 0) return 'Sem dados'
  return `${Math.round((100 * numerator) / denominator)}%`
}

export type TeamMemberCount = { id: number; active: number }
export type TeamProfileCount = { userId: number; automationPaused?: number | boolean }

export function calculateTeamSummary(members: TeamMemberCount[], profiles: TeamProfileCount[]) {
  const activeMembers = members.filter((member) => member.active === 1).length
  const pausedProfiles = profiles.filter((profile) => Boolean(profile.automationPaused)).length
  const unassignedProfiles = profiles.filter(
    (profile) => !members.some((member) => member.id === profile.userId && member.active === 1),
  ).length
  return { activeMembers, pausedProfiles, unassignedProfiles }
}
