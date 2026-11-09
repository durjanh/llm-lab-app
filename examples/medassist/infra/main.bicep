// MedAssist's real texts, added to an existing resource group (the lab's own, rg-llm-lab, by default): Communication
// Services, the reminders table and the reminder Function. setup-texts.sh deploys it and teardown-texts.sh removes
// these resources, found by their tag, and nothing else. The full lab's azd project uses the same module.
@description('A short name in the resources\' names, matching the lab\'s others.')
param environmentName string = 'llm-lab'

@description('Where the storage account and the Function run. Communication Services is global, with its data in the UK.')
param location string = resourceGroup().location

@description('You: given the roles to send texts and keep reminders from the lab backend.')
param principalId string

@description('The AI Services account in this group that speaks and listens on Aftercare\'s real calls.')
param aiServicesName string = ''

module texts '../../../infra/modules/medassist-texts.bicep' = {
  name: 'medassist-texts-resources'
  params: {
    environmentName: environmentName
    location: location
    principalId: principalId
    principalType: 'User'
    tags: { 'lab-part': 'medassist-texts' } // how teardown-texts.sh finds what to remove
    aiServicesName: aiServicesName
  }
}

output MEDASSIST_SMS_ENDPOINT string = texts.outputs.smsEndpoint
output MEDASSIST_REMINDERS_TABLE string = texts.outputs.remindersTableUrl
output functionAppName string = texts.outputs.functionAppName
