export default {
  ADD_EXTERNAL_DATASET: `#graphql
    mutation AddExternalDataset(
      $planId: Int!,
      $simulationDatasetId: Int,
      $datasetStart: String!,
      $profileSet: ProfileSet!) {
        addExternalDataset(
          planId: $planId,
          simulationDatasetId: $simulationDatasetId,
          datasetStart: $datasetStart,
          profileSet: $profileSet) {
          datasetId
        }
    }
  `,
  CREATE_ACTIVITY_DIRECTIVES: `#graphql
    mutation CreateActivityDirectives($activityDirectivesInsertInput: [activity_directive_insert_input!]!) {
      insert_activity_directive(objects: $activityDirectivesInsertInput) {
        returning {
          id
          type
        }
      }
    }
  `,
  CREATE_MISSION_MODEL: `#graphql
    mutation CreateMissionModel($model: mission_model_insert_input!) {
      insert_mission_model_one(object: $model) {
        id
        name
        version
      }
    }
  `,
  CREATE_PLAN: `#graphql
    mutation CreatePlan($plan: plan_insert_input!) {
      createPlan: insert_plan_one(object: $plan) {
        created_at
        collaborators {
          collaborator
        }
        duration
        id
        owner
        revision
        start_time
        simulations {
          id
        }
      }
    }
  `,
  CREATE_PLAN_TAGS: `#graphql
    mutation CreatePlanTags($tags: [plan_tags_insert_input!]!) {
      insert_plan_tags(objects: $tags, on_conflict: {
        constraint: plan_tags_pkey,
        update_columns: []
      }) {
        affected_rows
      }
    }
  `,
  CREATE_TAGS: `#graphql
    mutation CreateTags($tags: [tags_insert_input!]!) {
      insert_tags(objects: $tags) {
        returning {
          color
          created_at
          id
          name
          owner
        }
      }
    }
  `,
  DELETE_EXTERNAL_DATASET: `#graphql
    mutation DeleteExternalDataset($id: Int!) {
      delete_dataset_by_pk(id: $id) {
        id
      }
    }
  `,
  DELETE_MISSION_MODEL: `#graphql
    mutation DeleteMissionModel($id: Int!) {
      delete_mission_model_by_pk(id: $id) {
        id
      }
    }
  `,
  DELETE_PLAN: `#graphql
    mutation DeletePlan($id: Int!) {
      deletePlan: delete_plan_by_pk(id: $id) {
        id
      }
    }
  `,
  DELETE_TAGS: `#graphql
    mutation DeleteTags($tagIds: [Int!]! = []) {
      delete_tags(
        where: {
          id: { _in: $tagIds }
        }
      ) {
        affected_rows
      }
    }
  `,
  EXTEND_EXTERNAL_DATASET: `#graphql
    mutation ExtendExternalDataset($datasetId: Int!, $profileSet: ProfileSet!) {
      extendExternalDataset(datasetId: $datasetId, profileSet: $profileSet) {
        datasetId
      }
    }
  `,
  GET_MISSION_MODEL_BY_NATURAL_KEY: `#graphql
    query GetMissionModelByNaturalKey($mission: String!, $name: String!, $version: String!) {
      mission_model(where: {
        mission: {_eq: $mission},
        name: {_eq: $name},
        version: {_eq: $version}
      }) {
        external_identity_hash
        id
        model_type
      }
    }
  `,
  GET_TAGS: `#graphql
    query GetTags {
      tags(order_by: { name: desc })  {
        color
        created_at
        id
        name
        owner
      }
    }
  `,
  INGEST_EXTERNAL_SIMULATION_RESULTS: `#graphql
    mutation IngestExternalSimulationResults($planId: Int!, $results: ExternalSimulationResults!) {
      ingestExternalSimulationResults(planId: $planId, results: $results) {
        simulationDatasetId
      }
    }
  `,
  REGISTER_MODEL_TYPES: `#graphql
    mutation RegisterModelTypes(
      $missionModelId: Int!,
      $activityTypes: [ModelActivityTypeInput!]!,
      $resourceTypes: [ModelResourceTypeInput!]!,
      $parameters: [ModelParameterInput!]!) {
        registerModelTypes(
          missionModelId: $missionModelId,
          activityTypes: $activityTypes,
          resourceTypes: $resourceTypes,
          parameters: $parameters) {
          activityTypeCount
          parameterCount
          resourceTypeCount
        }
    }
  `,
  UPDATE_ACTIVITY_DIRECTIVES: `#graphql
    mutation UpdateActivityDirective($updates: [activity_directive_updates!]!) {
      update_activity_directive_many(
        updates: $updates
      ) {
        affected_rows
      }
    }
  `,
  UPDATE_SIMULATION: `#graphql
    mutation InitialSimulationUpdate($plan_id: Int!, $simulation: simulation_set_input!) {
      update_simulation(where: {plan_id: {_eq: $plan_id}}, _set: $simulation) {
        returning {
          id
        }
      }
    }
  `,
};
