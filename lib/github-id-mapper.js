// Description:
//   GitHub ID mapping to other connected systems (e.g. Slack)
//
// Dependencies:
//   mem-cache: "0.0.5"
//   @slack/client: "^3.16.0"
//
// Author:
//   PombeirP

const MemCache = require('mem-cache')
const { WebClient } = require('@slack/client')

const token = process.env.SLACK_USER_TOKEN || ''

module.exports = (robot) => new GitHubSlackIdMapper(robot)

class GitHubSlackIdMapper {
  constructor (robot) {
    this.robot = robot
    this.slackGitHubCache = new MemCache({ timeoutDisabled: true })
    this.buildPromise = new Promise((resolve, reject) => internalBuild(this.robot, this.cache).then(resolve).catch(reject))
  }

  async getGitHubIdFromSlackId (slackUserId, cache) {
    await this.buildPromise
    return cache.get(getSlackId2GitHubIdCacheKeyName(slackUserId))
  }

  async getSlackIdFromGitHubId (gitHubId) {
    await this.buildPromise
    return this.cache.get(getGitHub2SlackIdCacheKeyName(gitHubId))
  }

  async getSlackMentionFromGitHubId (gitHubId) {
    const id = await this.getSlackIdFromGitHubId(gitHubId)
    if (!id) {
      return null
    }
    return `<@${id}>`
  }
}

async function internalBuild (robot, cache) {
  robot.log.info('Populating Slack user ID cache...')

  try {
    const slackWeb = new WebClient(token) // We need to use a different token because users.profile API is not available to bot users
    const usersList = await slackWeb.users.list() // TODO: This call should be paginated to avoid hitting limits (memory, API): https://api.slack.com/docs/pagination#cursors
    const activeUsersList = usersList.members.filter(u => !u.deleted && !u.is_bot && u.id !== 'USLACKBOT')

    let gitHubFieldId = null
    let usersMissingGitHubInfo = []
    let usersContainingGitHubInfo = []
    let rateLimitWait = 10000
    let profileFetchPreviousBatchCount = 3
    let profileFetchBatchCount = 0
    for (let i = 0; i < activeUsersList.length;) {
      const user = activeUsersList[i]

      try {
        ++profileFetchBatchCount
        const { profile } = await slackWeb.users.profile.get({ user: user.id, include_labels: !gitHubFieldId })
        const username = profile.display_name_normalized || profile.real_name_normalized

        if (!gitHubFieldId) {
          // Find the field ID for the field with the 'Github ID' label
          gitHubFieldId = findGitHubLabelId(profile)
        }

        if (!gitHubFieldId) {
          robot.log.warn(`No GitHub ID field found in @${username} (${user.id}) profile!`)
          ++i
          continue
        }

        if (profile.fields && profile.fields[gitHubFieldId]) {
          const gitHubUsername = profile.fields[gitHubFieldId].value
          robot.log.debug(`@${username} (${user.id}) -> ${gitHubUsername}`)

          cache.set(getSlackId2GitHubIdCacheKeyName(user.id), gitHubUsername)
          cache.set(getGitHub2SlackIdCacheKeyName(gitHubUsername), user.id)
          usersContainingGitHubInfo = usersContainingGitHubInfo.concat(username)
        } else {
          robot.log.warn(`@${username} (${user.id}) has no GitHub ID set`)
          usersMissingGitHubInfo = usersMissingGitHubInfo.concat(username)
        }

        ++i
        await sleep(1500)
      } catch (e) {
        if (e.name === 'Error' && e.message === 'ratelimited') {
          robot.log.trace(`Rate-limited, waiting ${rateLimitWait / 1000}s...`)
          await sleep(rateLimitWait)
          if (profileFetchBatchCount < profileFetchPreviousBatchCount) {
            // If we managed to fetch fewer profiles than the last time we got rate-limited, then try increasing the wait period
            rateLimitWait += 5000
          }
          profileFetchPreviousBatchCount = profileFetchBatchCount
          profileFetchBatchCount = 0
          continue
        }

        throw e
      }
    }
    robot.log.info(`Populated Slack user ID cache with ${usersContainingGitHubInfo.length} users: ${usersContainingGitHubInfo.map(s => '@' + s).join(', ')}`)
    if (usersMissingGitHubInfo) {
      robot.log.warn(`The following ${usersMissingGitHubInfo.length} Slack users have no GitHub info in their profiles: ${usersMissingGitHubInfo.map(s => '@' + s).join(', ')}`)
    }
  } catch (e) {
    robot.log.error(`Error while populating Slack user ID cache: ${e}`)
  }
}

function findGitHubLabelId (profile) {
  if (profile.fields) {
    for (const fieldId in profile.fields) {
      const field = profile.fields[fieldId]
      if (field.label === 'Github ID') {
        return fieldId
      }
    }
  }

  return null
}

function getSlackId2GitHubIdCacheKeyName (slackUserId) {
  return `Slack-${slackUserId}`
}

function getGitHub2SlackIdCacheKeyName (gitHubUsername) {
  return `GitHub-${gitHubUsername}`
}

function timeout (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function sleep (timeoutMs) {
  await timeout(timeoutMs)
}
